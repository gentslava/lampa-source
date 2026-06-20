import Storage from './storage/storage'
import Platform from './platform'
import Utils from '../utils/utils'
import Activity from '../interaction/activity/activity'

const SAVE_PREFIX = 'infuse://x-callback-url/save?'
const PLAY_PREFIX = 'infuse://x-callback-url/play?'
const SEASON_EPISODE_RE = /\[S(\d+):E(\d+)\]/i

const DEFAULTS = {
    mode: 'save_and_play',
    seasonOnly: true,
    maxItems: 40,
    maxUrlLength: 65536
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

function compareStreamUrl(a, b) {
    if (!a || !b) return false

    a = sanitizeStreamUrl(a)
    b = sanitizeStreamUrl(b)

    if (a === b) return true

    return a.split('?')[0] === b.split('?')[0]
}

function parseEpisodeMeta(item) {
    if (!item) return { season: null, episode: null }

    let season = parsePositiveInt(item.season != null ? item.season : item.season_number)
    let episode = parsePositiveInt(item.episode != null ? item.episode : item.episode_number)

    if ((!season || !episode) && item.subtitle) {
        let subtitle = stripText(item.subtitle)
        let episodeMatch = subtitle.match(/(\d+)\s*$/)
        if (!episode) episode = parsePositiveInt(episodeMatch && episodeMatch[1])
    }

    if ((!season || !episode) && item.title) {
        let title = String(item.title)
        let match = title.match(SEASON_EPISODE_RE)

        if (match) {
            if (!season) season = parsePositiveInt(match[1])
            if (!episode) episode = parsePositiveInt(match[2])
        }
        else if (!episode) {
            let episodeMatch = title.match(/^(\d+)\s*\//) || title.match(/(?:^|\s)(\d{1,3})\s*[-–]\s/)
            if (episodeMatch) episode = parsePositiveInt(episodeMatch[1])
        }
    }

    return { season, episode }
}

function getRawPlaylist(data) {
    if (!data || !Array.isArray(data.playlist)) return []
    return data.playlist.filter((item) => item && !item.separator)
}

function enrichPlayItem(data, item) {
    item = item || {}
    let fromItem = parseEpisodeMeta(item)
    let patch = {}

    if (item.season == null && fromItem.season != null) patch.season = fromItem.season
    else if (item.season == null && data && data.season != null) patch.season = data.season

    if (item.episode == null && fromItem.episode != null) patch.episode = fromItem.episode

    if (!Object.keys(patch).length) return item

    return Object.assign({}, item, patch)
}

function normalizePlaylistItem(data, item) {
    return enrichPlayItem(data, item)
}

function resolvePlaylist(data) {
    let playlist = getRawPlaylist(data)

    if (!playlist.length) {
        if (data && data.url) return [normalizePlaylistItem(data, data)]
        return []
    }

    return playlist.map((item) => normalizePlaylistItem(data, item))
}

function findPlayItem(data, playlist) {
    playlist = playlist || resolvePlaylist(data)

    if (!playlist.length) return data

    let currentUrl = data && data.url ? sanitizeStreamUrl(data.url) : ''

    if (currentUrl) {
        for (let i = 0; i < playlist.length; i++) {
            if (compareStreamUrl(playlist[i].url, currentUrl)) return playlist[i]
        }
    }

    let dataMeta = parseEpisodeMeta(data)

    if (dataMeta.episode != null) {
        for (let i = 0; i < playlist.length; i++) {
            let meta = parseEpisodeMeta(playlist[i])

            if (dataMeta.episode !== meta.episode) continue
            if (dataMeta.season != null && meta.season != null && dataMeta.season !== meta.season) continue

            return playlist[i]
        }
    }

    return data
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
    if (!item || typeof item.url !== 'string') return '.mkv'

    let path = item.url.split('?')[0].split('#')[0].toLowerCase()
    let extMatch = /\.([a-z0-9]{2,5})$/i.exec(path)

    if (extMatch) return '.' + extMatch[1].toLowerCase()

    return '.mkv'
}

function resolveCard(data) {
    if (data && (data.card || data.movie)) return data.card || data.movie

    let activity = Activity.active()

    if (activity && (activity.card || activity.movie)) return activity.card || activity.movie

    return null
}

function getHumanTitle(movie) {
    if (!movie) return ''
    let rawTitle = (movie.original_name || movie.original_title || movie.name || movie.title || '').trim()
    return stripText(rawTitle) || ''
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

    let first = name.split(/\s+/)[0]

    if (first.endsWith("'s") || first.endsWith('s')) {
        first = first.replace(/['']s$/i, '').replace(/s$/i, '')
    }

    return first || name.split(/\s+/)[0]
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

function buildLaunchUrl(saveLinks, playLinks, data, options) {
    if (!saveLinks.length) return ''

    playLinks = playLinks && playLinks.length ? playLinks : saveLinks

    options = options || {}
    let mode = normalizeLaunchMode(options.mode)
    let resumePosition = getResumePosition(data)

    if (Platform.is('apple_tv') === true) {
        let tvPlayUrl = buildAppleTvPlayUrl(playLinks, resumePosition, resolveCallbacks(options))

        if (mode === 'play') return tvPlayUrl
        if (mode === 'save') return SAVE_PREFIX + buildSaveQuery(saveLinks)

        return SAVE_PREFIX + buildSaveQuery(saveLinks) + '&x-success=' + encodeURIComponent(tvPlayUrl)
    }

    if (mode === 'save') {
        return SAVE_PREFIX + buildSaveQuery(saveLinks)
    }

    let playUrl = PLAY_PREFIX + buildPlayQuery(playLinks, resumePosition)
    if (mode === 'play') return playUrl

    return SAVE_PREFIX + buildSaveQuery(saveLinks) + '&x-success=' + encodeURIComponent(playUrl)
}

function buildLaunchUrlLength(saveLinks, playLinks, data, options) {
    return buildLaunchUrl(saveLinks, playLinks, data, options).length
}

function getPlaylistItems(data) {
    return resolvePlaylist(data).filter((item) => typeof item.url === 'string')
}

function findStartIndex(items, data) {
    if (!items.length) return 0

    data = data || {}

    let currentUrl = data.url ? sanitizeStreamUrl(data.url) : ''

    if (currentUrl) {
        for (let i = 0; i < items.length; i++) {
            if (compareStreamUrl(items[i].url, currentUrl)) return i
        }
    }

    let dataMeta = parseEpisodeMeta(data)

    if (dataMeta.episode != null) {
        for (let i = 0; i < items.length; i++) {
            let meta = parseEpisodeMeta(items[i])

            if (dataMeta.episode !== meta.episode) continue
            if (dataMeta.season != null && meta.season != null && dataMeta.season !== meta.season) continue

            return i
        }
    }

    return 0
}

function rotatePlayLinks(links, startIndex) {
    if (!startIndex || startIndex <= 0 || startIndex >= links.length) return links

    return links.slice(startIndex).concat(links.slice(0, startIndex))
}

function buildLink(url, item, movie, sourceName) {
    let playItem = item || {}
    if (!playItem.url) playItem.url = url

    return {
        url: sanitizeStreamUrl(url),
        filename: generateFilename(playItem, movie, sourceName)
    }
}

function buildLinksForItems(data, items, movie, source, options, launchMode, startIndex) {
    startIndex = startIndex || 0
    let links = []

    for (let i = 0; i < items.length && links.length < options.maxItems; i++) {
        let playItem = normalizePlaylistItem(data, items[i])
        let link = buildLink(items[i].url, playItem, movie, source)
        let nextSave = links.concat([link])
        let nextPlay = rotatePlayLinks(nextSave, startIndex)
        let probeLength = buildLaunchUrlLength(nextSave, nextPlay, data, {
            mode: launchMode,
            x_success: options.x_success,
            x_error: options.x_error
        })

        if (probeLength > options.maxUrlLength && links.length) break

        links.push(link)
    }

    return links
}

function buildLinksFromPlayData(data, movie, options) {
    if (!data) return { saveLinks: [], playLinks: [] }

    options = options || resolveOptions(data)
    let source = formatSourceLabel(options.source)
    let launchMode = normalizeLaunchMode(options.mode)
    let items = getPlaylistItems(data)

    if (options.seasonOnly && options.season) {
        let targetSeason = options.season
        items = items.filter((item) => {
            let meta = parseEpisodeMeta(item)
            if (meta.season == null && data.season != null) meta.season = data.season
            return meta.season === targetSeason
        })
    }

    let startIndex = findStartIndex(items, data)
    let saveLinks = buildLinksForItems(data, items, movie, source, options, launchMode, startIndex)
    let playLinks = rotatePlayLinks(saveLinks, startIndex)

    if (!saveLinks.length && data.url) {
        let link = buildLink(data.url, normalizePlaylistItem(data, findPlayItem(data)), movie, source)
        saveLinks = [link]
        playLinks = [link]
    }

    return { saveLinks, playLinks }
}

/**
 * Сборка infuse://x-callback-url/… для externalPlayer().
 *
 * data.url — текущий поток
 * data.playlist — эпизоды/версии (season, episode, url)
 * data.card — TMDB-карточка (optional; иначе Activity.active().card / .movie)
 * data.source — короткое имя источника для [скобок] в filename (MODS, Filmix…)
 * data.infuse_mode — save | play | save_and_play (default)
 * data.season — фильтр плейлиста по сезону
 */
function buildExternalUrl(data, callbacks) {
    if (!data || !data.url) return null

    let options = resolveOptions(data, callbacks)
    let { saveLinks, playLinks } = buildLinksFromPlayData(data, resolveCard(data), options)

    if (!saveLinks.length) return null

    return buildLaunchUrl(saveLinks, playLinks, data, options)
}

function resolveCallbacks(callbacks) {
    callbacks = callbacks || {}
    let appleTvClient = Storage.field('apple_tv_client') ?? 'lampa'

    return {
        x_success: callbacks.x_success || (appleTvClient + '://infuseDidFinish'),
        x_error: callbacks.x_error || (appleTvClient + '://infuseDidFail')
    }
}

function buildFallbackUrl(data, callbacks) {
    if (!data || !data.url) return null

    callbacks = resolveCallbacks(callbacks)

    let url = sanitizeStreamUrl(data.url)

    if (Platform.is('apple_tv') === true) {
        let playlist = data.playlist ? encodeURIComponent(JSON.stringify(data.playlist)) : ''
        let infuseUrl = PLAY_PREFIX
            + 'x-success=' + encodeURIComponent(callbacks.x_success)
            + '&x-error=' + encodeURIComponent(callbacks.x_error)
            + '&url=' + encodeURIComponent(url)

        if (playlist) infuseUrl += '&playlist=' + playlist

        return infuseUrl
    }

    return PLAY_PREFIX + 'url=' + encodeURIComponent(url)
}

/**
 * Полный URL для Infuse: save_and_play + filenames, иначе простой play?url=…
 */
function resolveUrl(data, callbacks) {
    callbacks = resolveCallbacks(callbacks)

    return buildExternalUrl(data, callbacks) || buildFallbackUrl(data, callbacks)
}

export default {
    buildExternalUrl,
    buildFallbackUrl,
    buildLinksFromPlayData,
    buildLaunchUrl,
    generateFilename,
    formatSourceLabel,
    resolveCard,
    resolveCallbacks,
    resolveOptions,
    resolveUrl
}
