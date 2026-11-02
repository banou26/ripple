/**
 * The words `root` shows, in order: each element holding text, read whole, and each control's placeholder and name.
 * `skip` names elements whose text varies by run, such as a link built from the test's own origin.
 */
export const wordsIn = (root: Element, skip = 'code, pre') => [...root.querySelectorAll('*')].flatMap(element => [
  ...!element.closest(skip) && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    ? [element.textContent.replace(/\s+/gu, ' ').trim()]
    : [],
  ...['placeholder', 'aria-label'].map(name => element.getAttribute(name) ?? '').filter(Boolean),
])
