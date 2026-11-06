export const READ_TEXT_COLOR = "var(--neutralTertiary)"

export type ReadTextStyle = { color: string } | undefined

export function getReadTextStyle(hasRead: boolean): ReadTextStyle {
    return hasRead ? { color: READ_TEXT_COLOR } : undefined
}
