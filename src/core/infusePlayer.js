import Storage from './storage/storage'
import Platform from './platform'
import Utils from '../utils/utils'

const SAVE_PREFIX = 'infuse://x-callback-url/save?'
const PLAY_PREFIX = 'infuse://x-callback-url/play?'
const SEASON_EPISODE_RE = /\[S(\d+):E(\d+)\]/

const DEFAULTS = {
    mode: 'save_and_play',
    seasonOnly: true,
    maxItems: 40,
    maxUrlLength: 12000
}

function parsePositiveInt(value) {
    let parsed = parseInt(value, 10)
    return !isNaN(parsed) && parsed > 0 ? parsed : null
}

function stripText(value) {
    if (!value) return ''
    let text = Utils.clearHtmlTags ? Utils.clearHtmlTags(String(value)) : String(value).replace(/<[^>]*>/g, '')
    return text.replace(/\s+/g, ' ').trim()
}

function pad2(value) {
    let num = parseInt(value, 10) || 0
    return num < 10 ? '0' + num : '' + num
}

function sanitizeStreamUrl(url) {
    return String(url || '').replace('&preload', '&play').replace(/\s/g, '%20')
}

function parseEpisodeMeta(item) {
    if (!item) return { season: null, episode: null }

    let season = parsePositiveInt(item.season != null ? item.season : item.season_number)
    let episode = parsePositiveInt(item.episode != null ? item.episode : item.episode_number)

    if ((!season || !episode) && item.title) {
        let match = String(item.title).match(SEASON_EPISODE_RE)
        if (match) {
            if (!season) season = parsePositiveInt(match[1])
            if (!episode) episode = parsePositiveInt(match[2])
        }
    }

    return { season, episode }
}

function normalizeLaunchMode(mode) {
    if (mode === 'save' || mode === 'play' || mode === 'save_and_play') return mode
    return DEFAULTS.mode
}

function resolveOptions(data, callbacks = {}) {
    data = data || {}

    let season = data.season != null ? parseInt(data.season, 10) : null
    if ((season == null || isNaN(season)) && data) {
        season = parseEpisodeMeta(data).season
    }

    return {
        mode: data.infuse_mode || DEFAULTS.mode,
        seasonOnly: data.infuse_season_only !== false,
        season,
        maxItems: data.infuse_max_items || DEFAULTS.maxItems,
        maxUrlLength: data.infuse_max_url_length || DEFAULTS.maxUrlLength,
        source: data.source || '',
        x_success: callbacks.x_success,
        x_error: callbacks.x_error
    }
}

function getExtension(item) {
    if (!item || typeof item.url !== 'string') return '.m3u8'
    let path = item.url.split('?')[0].split('#')[0]
    let extMatch = /\.([a-z0-9]{2,5})$/i.exec(path)
    return extMatch ? ('.' + extMatch[1].toLowerCase()) : '.m3u8'
}

function getHumanTitle(movie) {
    if (!movie) return 'Media'
    let rawTitle = (movie.original_name || movie.original_title || movie.name || movie.title || '').trim()
    return stripText(rawTitle) || 'Media'
}

function getMovieYear(movie) {
    if (!movie) return ''
    let year = String(movie.release_date || movie.first_air_date || '').slice(0, 4)
    return year && year !== '0000' ? year : ''
}

function formatSourceLabel(raw) {
    if (!raw) return ''
    let name = stripText(raw)
    if (!name) return ''

    let bracketIdx = name.indexOf('[')
    if (bracketIdx !== -1) name = name.slice(0, bracketIdx).trim()

    name = name.replace(/[^\w\u0400-\u04FF.-]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!name) return ''

    return name.split(/\s+/)[0]
}

function formatVoiceLabel(item, isSeries, humanTitle) {
    if (!item) return ''

    let voiceName = stripText(item.voice_name)
    let title = stripText(item.title)

    if (!voiceName && !isSeries && title && !SEASON_EPISODE_RE.test(title)) {
        voiceName = title
    }

    if (!voiceName) return ''
    if (humanTitle && voiceName.toLowerCase() === humanTitle.toLowerCase()) return ''

    return voiceName.replace(/[\\\/:*?"<>|]/g, '').trim()
}

function formatSourceBracket(sourceOverride, item) {
    let raw = sourceOverride || (item && item.source) || ''
    let label = formatSourceLabel(raw)
    return label ? '[' + label + ']' : ''
}

function buildReadableFilename(parts, extension) {
    return parts.filter((part) => part && String(part).trim()).join(' ').replace(/\s+/g, ' ').trim() + extension
}

function generateFilename(item, movie, sourceOverride) {
    let extension = getExtension(item)
    let meta = parseEpisodeMeta(item)
    let season = meta.season
    let episode = meta.episode
    let isSeries = !!(movie && (movie.first_air_date || movie.name || movie.number_of_seasons || movie.number_of_episodes))
        || !!(season || episode)
    let humanTitle = getHumanTitle(movie)
    let voiceLabel = formatVoiceLabel(item, isSeries, humanTitle)
    let sourceBracket = formatSourceBracket(sourceOverride, item)
    let parts = []

    if (isSeries && (season || episode)) {
        parts.push(humanTitle)
        parts.push('S' + pad2(season || 1) + 'E' + pad2(episode || 1))
    } else {
        let year = getMovieYear(movie)
        parts.push(year ? humanTitle + ' (' + year + ')' : humanTitle)
    }

    if (voiceLabel) parts.push(voiceLabel)
    if (sourceBracket) parts.push(sourceBracket)

    return buildReadableFilename(parts, extension)
}

function getResumePosition(data) {
    if (!data || !data.timeline) return 0
    let tl = data.timeline

    if (tl.time != null && !isNaN(tl.time) && tl.time > 1) {
        return Math.max(0, Math.floor(tl.time))
    }

    if (tl.percent != null && tl.duration != null && tl.duration > 0) {
        let percent = tl.percent > 1 ? tl.percent / 100 : tl.percent
        return Math.max(0, Math.floor(tl.duration * percent))
    }

    return 0
}

function linkToQueryPart(link, position) {
    let part = 'url=' + encodeURIComponent(link.url)

    if (position != null && !isNaN(position) && position > 0) {
        part += '&position=' + Math.floor(position)
    }

    part += '&filename=' + encodeURIComponent(link.filename)
    return part
}

function buildSaveQuery(links) {
    return links.map((link) => linkToQueryPart(link)).join('&') + '&download=0'
}

function buildPlayQuery(links, resumePosition) {
    return links.map((link, index) => linkToQueryPart(link, index === 0 ? resumePosition : null)).join('&')
}

function buildAppleTvPlayUrl(links, resumePosition, callbacks) {
    callbacks = callbacks || {}

    let playlist = encodeURIComponent(JSON.stringify(links.map((item) => ({
        url: item.url,
        filename: item.filename
    }))))

    let infuseUrl = PLAY_PREFIX
        + 'x-success=' + encodeURIComponent(callbacks.x_success || 'lampa://infuseDidFinish')
        + '&x-error=' + encodeURIComponent(callbacks.x_error || 'lampa://infuseDidFail')
        + '&url=' + encodeURIComponent(links[0].url)
        + '&playlist=' + playlist

    if (resumePosition > 0) infuseUrl += '&position=' + resumePosition

    return infuseUrl
}

function buildLaunchUrl(links, data, options) {
    if (!links.length) return ''

    options = options || {}
    let mode = normalizeLaunchMode(options.mode)
    let resumePosition = getResumePosition(data)

    if (Platform.is('apple_tv') === true) {
        let appleTvClient = Storage.field('apple_tv_client') ?? 'lampa'
        let tvPlayUrl = buildAppleTvPlayUrl(links, resumePosition, {
            x_success: options.x_success || (appleTvClient + '://infuseDidFinish'),
            x_error: options.x_error || (appleTvClient + '://infuseDidFail')
        })

        if (mode === 'play') return tvPlayUrl
        if (mode === 'save') return SAVE_PREFIX + buildSaveQuery(links)

        return SAVE_PREFIX + buildSaveQuery(links) + '&x-success=' + encodeURIComponent(tvPlayUrl)
    }

    if (mode === 'save') {
        return SAVE_PREFIX + buildSaveQuery(links)
    }

    let playUrl = PLAY_PREFIX + buildPlayQuery(links, resumePosition)
    if (mode === 'play') return playUrl

    return SAVE_PREFIX + buildSaveQuery(links) + '&x-success=' + encodeURIComponent(playUrl)
}

function getPlaylistItems(data) {
    let playlist = Array.isArray(data.playlist) ? data.playlist : []
    return playlist.filter((item) => item && !item.separator && typeof item.url === 'string')
}

function findStartIndex(items, currentUrl) {
    if (!currentUrl) return 0

    let target = sanitizeStreamUrl(currentUrl)

    for (let i = 0; i < items.length; i++) {
        if (sanitizeStreamUrl(items[i].url) === target) return i
    }

    return 0
}

function buildLink(url, item, movie, sourceName) {
    let playItem = item || {}
    if (!playItem.url) playItem.url = url

    return {
        url: sanitizeStreamUrl(url),
        filename: generateFilename(playItem, movie, sourceName)
    }
}

function buildLinksFromPlayData(data, movie, options) {
    if (!data) return []

    options = options || resolveOptions(data)
    let source = formatSourceLabel(options.source)
    let launchMode = normalizeLaunchMode(options.mode)
    let items = getPlaylistItems(data)

    if (options.seasonOnly && options.season) {
        let targetSeason = options.season
        items = items.filter((item) => parseEpisodeMeta(item).season === targetSeason)
    }

    let startIndex = findStartIndex(items, data.url)
    if (startIndex > 0) items = items.slice(startIndex)

    let links = []

    for (let i = 0; i < items.length && links.length < options.maxItems; i++) {
        let link = buildLink(items[i].url, items[i], movie, source)
        let probe = buildLaunchUrl(links.concat([link]), data, {
            mode: launchMode,
            x_success: options.x_success,
            x_error: options.x_error
        })

        if (probe.length > options.maxUrlLength && links.length) break

        links.push(link)
    }

    if (!links.length && data.url) {
        links.push(buildLink(data.url, data, movie, source))
    }

    return links
}

/**
 * Сборка infuse://x-callback-url/… для externalPlayer().
 *
 * data.url — текущий поток
 * data.playlist — эпизоды/версии (url: string)
 * data.card — TMDB-карточка (original_title, release_date…)
 * data.source — короткое имя источника для [скобок] в filename
 * data.infuse_mode — save | play | save_and_play (default)
 * data.season — фильтр плейлиста по сезону
 */
function buildExternalUrl(data, callbacks) {
    if (!data || !data.url) return null

    let options = resolveOptions(data, callbacks)
    let links = buildLinksFromPlayData(data, data.card || null, options)

    if (!links.length) return null

    return buildLaunchUrl(links, data, options)
}

export default {
    buildExternalUrl,
    buildLinksFromPlayData,
    buildLaunchUrl,
    generateFilename,
    formatSourceLabel,
    resolveOptions
}
