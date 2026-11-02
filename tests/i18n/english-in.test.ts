import { expect, test } from 'vitest'

import { englishIn } from '../languages'

test('a message with no word of its own is no English left on a page, one with words still is', () => {
  const english = { '{label}: {names}': '{label}: {names}', Audio: 'Audio' }
  const ja = { '{label}: {names}': '{label}：{names}', Audio: '音声' }
  expect(englishIn(['Session 1: Misunderstandings', 'Audio'], english, ja)).toEqual(['"Audio" (Audio)'])
  expect(englishIn(['Session 1: Misunderstandings', 'Audio'], english)).toEqual(['"Audio" (Audio)'])
})

test('a text the language writes for one message is no English left, though another\'s English reads alike', () => {
  const english = { 'Download#a speed': 'Download', 'Download#verb': 'Download', 'Download {name}': 'Download {name}', 'Start downloading': 'Start downloading' }
  const de = { 'Download#a speed': 'Download', 'Download#verb': 'Herunterladen', 'Download {name}': '{name} herunterladen', 'Start downloading': 'Download starten' }
  expect(englishIn(['Download', 'Download starten'], english, de)).toEqual([])
  expect(englishIn(['Download Sintel'], english, de)).toEqual(['"Download Sintel" (Download {name})'])
})
