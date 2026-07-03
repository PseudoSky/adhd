import text from './text';

describe('transforms', () => {
  it('should work', () => {
    expect(text.trim('asdf  ')).toEqual('asdf');
    expect(text.trimStart('  asdf  ')).toEqual('asdf  ');
    expect(text.trimEnd('  asdf  ')).toEqual('  asdf');
    expect(text.upperFirst("asdf")).toEqual("Asdf");
    expect(text.lowerFirst("Asdf")).toEqual("asdf");
    expect(text.capitalize("asdf asdf")).toEqual("Asdf asdf");
    expect(text.toLower("ASdf")).toEqual("asdf");
    expect(text.toUpper('ASdf')).toEqual('ASDF');
    // expect(text.shortUUID()).toMatch(/[a-zA-Z0-9_-]{9}/);
    expect(text.percent(90)).toEqual('+90.00%');
    expect(text.words("asdf")).toEqual(["asdf"]);
    expect(text.words("AsDf")).toEqual(["As", "Df"]);
    expect(text.words("As Df")).toEqual(["As", "Df"]);
    expect(text.hyphenCase("asdf asdf")).toEqual("asdf-asdf");
  });
});
