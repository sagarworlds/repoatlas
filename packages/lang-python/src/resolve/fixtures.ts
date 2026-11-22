import type { Definition, FileExtraction, RawReference } from "@repoatlas/schema";

/** A type name together with the file whose imports give that name its meaning. */
export interface ScopedHint {
  extraction: FileExtraction;
  hint: string;
}

const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function lastSegment(dotted: string): string {
  return dotted.slice(dotted.lastIndexOf(".") + 1);
}

function isFixture(def: Definition): boolean {
  const decorators = def.meta?.["py.decorators"];
  return Array.isArray(decorators) && decorators.some((d) => lastSegment(String(d)) === "fixture");
}

/** The function parameter `name` of the enclosing function chain, if there is one. */
function declaresParameter(
  byId: ReadonlyMap<string, Definition>,
  fromLocalId: string | undefined,
  name: string,
): boolean {
  let current = fromLocalId === undefined ? undefined : byId.get(fromLocalId);
  while (current !== undefined) {
    const params = current.meta?.["py.params"];
    if (Array.isArray(params) && params.includes(name)) return true;
    current = current.parentLocalId === undefined ? undefined : byId.get(current.parentLocalId);
  }
  return false;
}

/** The file itself, then `conftest.py` of its directory and of every parent directory. */
function fixtureFiles(file: string): string[] {
  const files = [file];
  let dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  for (;;) {
    files.push(dir === "" ? "conftest.py" : `${dir}/conftest.py`);
    if (dir === "") break;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
  return files;
}

/**
 * pytest injects a fixture by parameter name: in `def test_x(runner): runner.invoke()` the
 * value of `runner` is what the `@pytest.fixture def runner()` of the same file or of a
 * `conftest.py` up the directory tree returns. When that fixture returns one known class,
 * that class is the type of the receiver. The name is read in the fixture's own file, where
 * its import lives.
 */
export function fixtureReceiverHint(
  extractionsByFile: ReadonlyMap<string, FileExtraction>,
  extraction: FileExtraction,
  byId: ReadonlyMap<string, Definition>,
  ref: RawReference,
): ScopedHint | undefined {
  const receiver = ref.receiver;
  if (receiver === undefined || !SIMPLE_NAME.test(receiver)) return undefined;
  if (ref.receiverTypeHint !== undefined) return undefined;
  if (ref.receiverKind !== undefined && ref.receiverKind !== "identifier") return undefined;
  if (!declaresParameter(byId, ref.fromLocalId, receiver)) return undefined;

  for (const file of fixtureFiles(extraction.file)) {
    const candidate = extractionsByFile.get(file);
    const fixture = candidate?.definitions.find(
      (d) =>
        d.parentLocalId === undefined &&
        d.kind === "function" &&
        d.name === receiver &&
        isFixture(d),
    );
    if (candidate === undefined || fixture === undefined) continue;
    const returns = fixture.meta?.["py.returns"];
    // The nearest fixture decides, even when its type is unknown.
    return typeof returns === "string" ? { extraction: candidate, hint: returns } : undefined;
  }
  return undefined;
}
