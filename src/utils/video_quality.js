import Storage from './storage'
import Favorite from './favorite'
import Reguest from './reguest'

let data     = []
let network  = new Reguest()
let videocdn = 'https://videocdn.tv/api/short?api_token=3i40G5TSECmLF77oAqnEgbx61ZWaOYaE'
let object   = false

/**
 * Запуск
 */
function init(){
    data = Storage.cache('quality_scan',500,[])

    setInterval(extract,30*1000)
}

function add(elems){
    elems.filter(elem=>!elem.number_of_seasons).forEach(elem=>{
        let id = data.filter(a=>a.id == elem.id)

        if(!id.length){
            data.push({
                id: elem.id,
                title: elem.title,
                imdb_id: elem.imdb_id
            })
        } 
    })

    Storage.set('quality_scan',data)
}

function req(imdb_id, query){
    let url = videocdn + '&' + (imdb_id ? 'imdb_id=' + encodeURIComponent(imdb_id) : 'title='+encodeURIComponent(query))

    network.timeout(1000*15)
    
    network.silent(url,(json)=>{
        if(json.data && json.data.length){
            if(object.imdb_id){
                let imdb = json.data.filter(elem=>elem.imdb_id == object.imdb_id)

                if(imdb.length) json.data = imdb
            }

            if(json.data.length){
                object.quality = json.data[0].quality
            }
        }

        save()
    },save)
}

function extract(){
    let ids = data.filter(e=>!e.scaned && (e.scaned_time || 0) + (60 * 60 * 12 * 1000) < Date.now())

    if(ids.length){
        object = ids[0]

        if(object.imdb_id){
            req(object.imdb_id)
        } 
        else{
            network.silent('http://api.themoviedb.org/3/movie/' + object.id + '/external_ids?api_key=4ef0d7355d9ffb5151e987764708ce96&language=ru', function (ttid) {
                req(ttid.imdb_id, object.title)
            },save)
        }
    }
    else{
        data.forEach(a=>a.scaned = 0)
    }

    Storage.set('quality_scan',data)
}

function save(){
    if(object){
        object.scaned = 1
        object.scaned_time = Date.now()

        Storage.set('quality_scan',data)
    }
}

function get(elem){
    let fid = data.filter(e=>e.id == elem.id)

    return (fid.length ? fid[0] : {}).quality
}

export default {
    init,
    get,
    add
}