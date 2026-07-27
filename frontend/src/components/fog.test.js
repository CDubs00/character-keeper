// Unit tests for stripFog — the pure function that produces the text a
// read-tier PLAYER would receive: fogged ||…|| spans removed entirely, wiki
// links flattened to their display text. It is UNWIRED today (worlds are
// owner-only); this test locks its behavior in NOW so §7 can bolt it onto the
// player-read path with confidence. If this ever regresses, a fogged secret
// could leak to a player — so the "dropped whole" guarantee is the key assertion.

import { stripFog } from './fog';

describe('stripFog', () => {
  test('plain text is unchanged', () => {
    expect(stripFog('Just a normal sentence.')).toBe('Just a normal sentence.');
  });

  test('removes a fogged span entirely (not just the markers)', () => {
    expect(stripFog('The vault is guarded ||by a red dragon||.'))
      .toBe('The vault is guarded .');
  });

  test('drops the fog content whole so its length cannot leak', () => {
    const out = stripFog('Secret: ||xxxxxxxxxxxxxxxxxxxx||done');
    expect(out).toBe('Secret: done');
    expect(out).not.toMatch(/x/);
  });

  test('removes multiple fogged spans', () => {
    expect(stripFog('||a|| middle ||b|| end')).toBe(' middle  end');
  });

  test('flattens a wiki link to its name', () => {
    expect(stripFog('Ask [[Durnan]] about it.')).toBe('Ask Durnan about it.');
  });

  test('flattens a piped wiki link to its display text', () => {
    expect(stripFog('Domains: [[Life Domain|Light]].')).toBe('Domains: Light.');
  });

  test('handles fog and links together', () => {
    expect(stripFog('[[Durnan]] hides ||the key|| well'))
      .toBe('Durnan hides  well');
  });

  test('an unmatched || opener stays literal (nothing vanishes mid-type)', () => {
    expect(stripFog('cost is ||50 gold')).toBe('cost is ||50 gold');
  });

  test('empty / non-string input yields an empty string', () => {
    expect(stripFog('')).toBe('');
    expect(stripFog(undefined)).toBe('');
    expect(stripFog(null)).toBe('');
  });
});
