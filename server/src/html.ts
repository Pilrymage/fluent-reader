const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
}

/** Strip markup and decode the handful of entities feeds actually emit. */
export function textOf(html: string): string {
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
            if (name.startsWith("#")) {
                const code =
                    name[1].toLowerCase() === "x"
                        ? parseInt(name.slice(2), 16)
                        : parseInt(name.slice(1), 10)
                return Number.isFinite(code)
                    ? String.fromCodePoint(code)
                    : match
            }
            return ENTITIES[name.toLowerCase()] ?? match
        })
        .replace(/\s+/g, " ")
        .trim()
}

export function firstImage(html: string): string | null {
    const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html)
    return match ? match[1] : null
}
