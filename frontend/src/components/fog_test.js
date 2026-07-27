// Unit tests for stripFog — the pure function that produces the text a
// read/propose-tier PLAYER receives: fogged ||…|| spans removed entirely, wiki
// links PRESERVED as authored. The live enforcement copy is backend/loreAccess.js
// (applied by serializeEntryForRole before any non-owner response); this file is
// the audited reference the two are kept in sync against — every assertion here
// has a twin in backend/loreAccess.test.js.
//
// If this ever regresses, a fogged secret could leak to a player — so the
// "dropped whole" guarantee is the key assertion, and the fogged-LINK case below
// is what pins it: a link inside fog must vanish name and all.

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

  test('preserves an unfogged wiki link', () => {
    // Not fogged = meant to be followed. Whether the TARGET is readable is decided
    // by canSee when the player navigates, not by mangling the syntax here.
    expect(stripFog('Ask [[Durnan]] about it.')).toBe('Ask [[Durnan]] about it.');
  });

  test('preserves a piped wiki link, alias intact', () => {
    expect(stripFog('Domains: [[Life Domain|Light]].')).toBe('Domains: [[Life Domain|Light]].');
  });

  test('drops a FOGGED link whole — the target name must not leak', () => {
    const out = stripFog('Go to ||[[Hidden Fortress]]|| next.');
    expect(out).toBe('Go to  next.');
    expect(out).not.toMatch(/Hidden Fortress/);
    expect(out).not.toMatch(/\[\[/);
  });

  test('keeps an unfogged link while dropping adjacent fog', () => {
    expect(stripFog('[[Durnan]] hides ||the key|| well'))
      .toBe('[[Durnan]] hides  well');
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
