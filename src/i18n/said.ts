// Words the engine worker hands the page, which the page writes in its language where it shows them (wordsOf,
// ./index.ts), since the worker loads no catalogue. Import free, so the worker writes them too.

/** Words for the viewer: one of ripple's messages, by its id, with its values; or a string, shown as it came. */
export type Said = string | SaidMessage

/** One of ripple's messages, as `forPage.formatMessage` writes it. Its id is its English. */
export type SaidMessage = { readonly message: string, readonly values?: Readonly<Record<string, string | number>> }

/**
 * Writes one of ripple's messages where no catalogue is loaded, for the page to word: the descriptor and values
 * `intl.formatMessage` takes, less a description, since the page reads the id as the English. Named as react-intl's
 * so the linter and `npm run i18n:check` read each call as they read every `intl.formatMessage`, its values against
 * its placeholders included.
 */
export const forPage = {
  formatMessage: (descriptor: { id: string, defaultMessage: string }, values?: SaidMessage['values']): SaidMessage =>
    values ? { message: descriptor.id, values } : { message: descriptor.id },
}
