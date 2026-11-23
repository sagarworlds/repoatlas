/** Fixed Java vocabularies used by the resolver: stoplist, java.lang, implicit members. */

/**
 * Method names that are never name-matched (added to the shared stoplist). They are the
 * everyday methods of the JDK collections, streams, strings, builders and logging, so a
 * name-match on them would almost always point at an unrelated class.
 */
export const JAVA_STOPLIST: ReadonlySet<string> = new Set([
  // java.lang.Object and friends
  "toString",
  "equals",
  "hashCode",
  "getClass",
  "clone",
  "compareTo",
  "compare",
  "name",
  "ordinal",
  "values",
  "valueOf",
  // collections, maps, optionals
  "size",
  "length",
  "isEmpty",
  "contains",
  "containsKey",
  "containsValue",
  "put",
  "putAll",
  "putIfAbsent",
  "get",
  "getOrDefault",
  "add",
  "addAll",
  "addFirst",
  "addLast",
  "remove",
  "removeAll",
  "clear",
  "iterator",
  "keySet",
  "entrySet",
  "isPresent",
  "orElse",
  "orElseGet",
  "orElseThrow",
  "ifPresent",
  "toArray",
  "asList",
  "copyOf",
  "emptyList",
  "emptyMap",
  "singletonList",
  "of",
  "ofNullable",
  "first",
  "last",
  "peek",
  "poll",
  "push",
  "pop",
  "offer",
  // streams
  "stream",
  "collect",
  "map",
  "filter",
  "forEach",
  "reduce",
  "flatMap",
  "sorted",
  "distinct",
  "limit",
  "skip",
  "count",
  "anyMatch",
  "allMatch",
  "noneMatch",
  "findFirst",
  "findAny",
  "toList",
  "joining",
  "toSet",
  "toMap",
  "groupingBy",
  // strings and builders
  "format",
  "append",
  "insert",
  "substring",
  "trim",
  "split",
  "join",
  "replace",
  "startsWith",
  "endsWith",
  "toLowerCase",
  "toUpperCase",
  "charAt",
  "indexOf",
  "equalsIgnoreCase",
  "parseInt",
  "parseLong",
  "build",
  "builder",
  // io and lifecycle
  "close",
  "flush",
  "read",
  "write",
  "open",
  "run",
  "call",
  "apply",
  "accept",
  "test",
  "init",
  "start",
  "stop",
  "update",
  "delete",
  "print",
  "println",
  "printStackTrace",
  // accessors that exist in nearly every class
  "getName",
  "getId",
  "getValue",
  "getKey",
  "getMessage",
  "getType",
  "setName",
  "setId",
  "setValue",
  "set",
  "is",
  // logging
  "log",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  // threads
  "sleep",
  "join",
  "interrupt",
  "wait",
  "notify",
  "notifyAll",
]);

/** Methods every object has; a missing member with one of these names is never unresolved. */
export const OBJECT_METHODS: ReadonlySet<string> = new Set([
  "toString",
  "equals",
  "hashCode",
  "getClass",
  "clone",
  "finalize",
  "notify",
  "notifyAll",
  "wait",
]);

/** Members the compiler adds to every enum. */
export const ENUM_METHODS: ReadonlySet<string> = new Set([
  "values",
  "valueOf",
  "ordinal",
  "name",
  "compareTo",
  "getDeclaringClass",
  "describeConstable",
]);

/** Types of `java.lang` (visible without an import) that code commonly uses by simple name. */
export const JAVA_LANG_TYPES: ReadonlySet<string> = new Set([
  "Object",
  "String",
  "StringBuilder",
  "StringBuffer",
  "Math",
  "StrictMath",
  "System",
  "Thread",
  "ThreadLocal",
  "Runtime",
  "Process",
  "ProcessBuilder",
  "Integer",
  "Long",
  "Double",
  "Float",
  "Boolean",
  "Byte",
  "Short",
  "Character",
  "Number",
  "Void",
  "Class",
  "ClassLoader",
  "Enum",
  "Record",
  "Iterable",
  "Comparable",
  "Runnable",
  "CharSequence",
  "AutoCloseable",
  "Cloneable",
  "StackTraceElement",
  "Throwable",
  "Exception",
  "RuntimeException",
  "Error",
  "AssertionError",
  "IllegalArgumentException",
  "IllegalStateException",
  "NullPointerException",
  "UnsupportedOperationException",
  "ArithmeticException",
  "ClassCastException",
  "IndexOutOfBoundsException",
  "ArrayIndexOutOfBoundsException",
  "StringIndexOutOfBoundsException",
  "NumberFormatException",
  "InterruptedException",
  "CloneNotSupportedException",
  "ClassNotFoundException",
  "ReflectiveOperationException",
  "SecurityException",
  "StackOverflowError",
  "OutOfMemoryError",
  "Appendable",
  "Readable",
  "Package",
  "Module",
  "ThreadGroup",
  "InheritableThreadLocal",
  "SecurityManager",
  "IllegalAccessException",
  "InstantiationException",
  "NoSuchMethodException",
  "NoSuchFieldException",
  "IllegalMonitorStateException",
  "IllegalThreadStateException",
  "NegativeArraySizeException",
  "ArrayStoreException",
  "EnumConstantNotPresentException",
  "TypeNotPresentException",
  "LinkageError",
  "NoClassDefFoundError",
  "ExceptionInInitializerError",
  "VirtualMachineError",
  "InternalError",
  "UnsatisfiedLinkError",
  "NoSuchMethodError",
  "NoSuchFieldError",
  "IncompatibleClassChangeError",
  "AbstractMethodError",
  "IllegalAccessError",
  "InstantiationError",
  "ClassFormatError",
  "VerifyError",
  "Override",
  "Deprecated",
  "FunctionalInterface",
  "SuppressWarnings",
  "SafeVarargs",
]);

/** Annotations (Lombok) whose presence means the class has generated members. */
export const GENERATING_ANNOTATIONS: ReadonlySet<string> = new Set([
  "Data",
  "Getter",
  "Setter",
  "Value",
  "Builder",
  "SuperBuilder",
  "With",
  "AllArgsConstructor",
  "NoArgsConstructor",
  "RequiredArgsConstructor",
  "ToString",
  "EqualsAndHashCode",
  "Slf4j",
  "Log4j2",
  "Log",
  "Accessors",
]);

/** Roots of the top-level segment of well-known JDK packages. */
const JDK_ROOTS: ReadonlySet<string> = new Set(["java", "javax", "jdk", "sun"]);
const JDK_PREFIXES: ReadonlySet<string> = new Set([
  "com.sun",
  "org.w3c",
  "org.xml",
  "org.ietf",
  "org.omg",
]);
/** Prefixes that name a vendor, so the next segment is part of the artifact's identity. */
const OWNER_PREFIXES: ReadonlySet<string> = new Set(["com.github", "io.github"]);
const THREE_SEGMENT_PREFIXES: ReadonlySet<string> = new Set([
  "com.google.cloud",
  "org.apache.commons",
]);
/** Top-level domains alone are never a useful external name. */
const TOP_LEVEL_ONLY: ReadonlySet<string> = new Set(["com", "org", "net", "io", "edu", "gov"]);

/** Segment starts with an upper case letter: a class name, not a package. */
export function isCapitalised(segment: string): boolean {
  const first = segment.charAt(0);
  return first !== "" && first === first.toUpperCase() && first !== first.toLowerCase();
}

/** A class-like simple name: starts upper case and has a lower case letter (not CONSTANT). */
export function looksLikeTypeName(name: string): boolean {
  return isCapitalised(name) && name !== name.toUpperCase();
}

/** `java.util.Map.Entry` -> `java.util`: the leading segments that are not capitalised. */
export function packagePartOf(fqn: string): string {
  const kept: string[] = [];
  for (const segment of fqn.split(".")) {
    if (segment === "" || isCapitalised(segment)) break;
    kept.push(segment);
  }
  return kept.join(".");
}

/**
 * The external package key for the `ext:maven:{key}` node of a package that is not in the
 * repository. `jdk` for the JDK; a declared Maven groupId when one is a prefix of the
 * package (longest wins); otherwise the first two segments, three for `com.github`,
 * `io.github`, `com.google.cloud` and `org.apache.commons`. Undefined for an empty package.
 */
export function externalKeyFor(
  packageName: string,
  declaredGroups: readonly string[] = [],
): string | undefined {
  const segments = packageName.split(".").filter((s) => s !== "");
  const first = segments[0];
  if (first === undefined) return undefined;
  if (JDK_ROOTS.has(first)) return "jdk";
  const firstTwo = segments.slice(0, 2).join(".");
  if (JDK_PREFIXES.has(firstTwo)) return "jdk";

  const dotted = segments.join(".");
  let best: string | undefined;
  for (const group of declaredGroups) {
    if (TOP_LEVEL_ONLY.has(group)) continue;
    const matches = dotted === group || dotted.startsWith(`${group}.`);
    if (matches && (best === undefined || group.length > best.length)) best = group;
  }
  if (best !== undefined) return best;

  if (OWNER_PREFIXES.has(firstTwo) || THREE_SEGMENT_PREFIXES.has(segments.slice(0, 3).join("."))) {
    return segments.slice(0, 3).join(".");
  }
  return segments.slice(0, 2).join(".");
}
