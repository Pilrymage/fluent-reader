function get(name) {
    if (name = (new RegExp('[?&]' + encodeURIComponent(name) + '=([^&]*)')).exec(location.search))
        return decodeURIComponent(name[1]);
}
let dir = get("d")
if (dir === "1") {
    document.body.classList.add("rtl")
} else if (dir === "2") {
    document.body.classList.add("vertical")
    document.body.addEventListener("wheel", (evt) => {
        document.scrollingElement.scrollLeft -= evt.deltaY;
    });
}
async function getArticle(url) {
    let article = get("a")
    if (get("m") === "1") {
        return (await Mercury.parse(url, {html: article})).content || ""
    } else {
        return article
    }
}
document.documentElement.style.fontSize = get("s") + "px"
let font = get("f")
if (font) document.body.style.fontFamily = `"${font}"`
let url = get("u")

function render(article) {
    let domParser = new DOMParser()
    let dom = domParser.parseFromString(get("h"), "text/html")
    dom.getElementsByTagName("article")[0].innerHTML = article
    let baseEl = dom.createElement('base')
    baseEl.setAttribute('href', (url || "").split("/").slice(0, 3).join("/"))
    dom.head.append(baseEl)
    for (let s of dom.getElementsByTagName("script")) {
        s.parentNode.removeChild(s)
    }
    for (let e of dom.querySelectorAll("*[src]")) {
        e.src = e.src
    }
    for (let e of dom.querySelectorAll("*[href]")) {
        e.href = e.href
    }
    let main = document.getElementById("main")
    main.innerHTML = dom.body.innerHTML
    main.classList.add("show")
}

if (get("a")) {
    getArticle(url).then(render)
} else {
    // Browser build: article bodies average 2.8 KB and reach 144 KB, which is
    // far past the server's header limit for a query string, so the host page
    // hands the body over after the frame loads instead.
    window.addEventListener("message", event => {
        if (event.origin !== location.origin) return
        const data = event.data
        if (!data || data.type !== "fr-article") return
        if (data.id !== undefined && String(data.id) !== get("id")) return
        render(data.article)
    })
}

// Relay keystrokes to the host page: an iframe swallows its own keydowns, but
// the reader's single-key shortcuts must keep working while reading. The host
// only listens for this in the browser build.
if (window.parent !== window) {
    window.addEventListener("keydown", event => {
        window.parent.postMessage(
            {
                type: "fr-keydown",
                input: {
                    type: "keyDown",
                    key: event.key,
                    code: event.code,
                    shift: event.shiftKey,
                    alt: event.altKey,
                    control: event.ctrlKey,
                    meta: event.metaKey,
                    isAutoRepeat: event.repeat,
                },
            },
            "*"
        )
    }, true)
}
