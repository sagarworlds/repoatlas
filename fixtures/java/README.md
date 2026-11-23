# Java fixture

Parsed only, never compiled or executed. `repo/` is a Maven project (`pom.xml` is ignored by the
plugin) with `src/main/java/com/acme/shop/{model,service,util,api}` and one test under
`src/test/java`. 16 Java files. Expectations live in `expected-edges.json`.

Id conventions assumed: `file:{path}`, `sym:{path}#{Outer.Inner.member}`. Constructors are
`Class.Class` (`isConstructor`), the later overload gets `@startLine`
(`User.User@19`, `Strings.pad@20`, `Strings.mask@28`; the line numbers are the declaration lines
in the current sources, so editing those files means updating the ids). Enums and records are
`kind: class` with `java.kind`. Externals are `ext:maven:{first two segments}` (`jdk` for `java.*`).

| File | Purpose / what it proves |
|---|---|
| `model/Entity.java` | Abstract base: protected constructor, `touch()` calls `describe()` unqualified, abstract `kind()` |
| `model/Auditable.java` | Interface with a default method calling its own abstract `label()` |
| `model/User.java` | `extends Entity implements Auditable`; `super(id)`, `this(0L, name)`, two constructor overloads; static import `capitalize(name)`; `Strings.pad(name, 12)`; `this.touch()` (inherited), `validate()`, `super.describe()`; static `create` |
| `model/Order.java` | Cross-package cycle with `OrderService`; static nested `Line` (own constructor), inner `Totals` calling outer `owner()`; enhanced-for typed receiver (`line.cost()`), local typed receiver (`sum.plus`), enum-typed field (`status.label()`), inherited calls |
| `model/Status.java` | Enum with constructor and methods; unqualified `label()` must resolve inside the enum |
| `model/Money.java` | Record; `new Money(...)` has no declared constructor, so a `references` edge to the class |
| `util/Strings.java` | Static helpers; overloads `pad(1)`/`pad(2)` picked by argument count; `mask(String)`/`mask(CharSequence)` genuinely ambiguous (same arity) |
| `util/Result.java` | Generic class, generic static methods, private constructor, `new Result<>(...)` |
| `util/Validators.java` | Target of the wildcard import |
| `service/UserRepository.java` | Interface used as a field type |
| `service/InMemoryUserRepository.java` | Implements it; implementations are NOT linked from interface-typed calls |
| `service/OrderService.java` | Other half of the cycle; static `discountPercent` |
| `service/UserService.java` | `@Service` (external import); interface-typed field `repo.save`; `new User(name)` picks the 1-arg constructor; `var order = new Order(...)`; `User.create`; same-package class used without import; method reference `this::handle`, lambda, anonymous `Runnable` (all attributed to `handleAll`) |
| `api/UserController.java` | Wildcard import `com.acme.shop.util.*`, external Spring annotations |
| `api/Broken.java` | Two valid methods, then a syntax error inside a method body: `parseErrors > 0` |
| `test/.../UserServiceTest.java` | Test file (`isTest`), `@Test` methods, field-typed receiver, JUnit externals |

## Choices worth knowing

- `minResolutionRate` is 0.8. Almost every internal call resolves. The slack covers calls that
  are not resolvable by design: `mask(name)` (ambiguous, so unresolved or name-match), receivers
  of JDK types (`text.toUpperCase()`, `users.forEach`, `byName.put`), and `job.run()`. docs/TESTING.md
  targets 75% for real-world Java.
- `parseErrorFiles` lists only `Broken.java`. The error sits in the body of the third method, so
  `Broken`, `healthy` and `alsoFine` are still extracted (verified against tree-sitter-java 0.23.5).
- The ambiguous `Strings.mask(name)` call has no positive assertion (unresolved and name-match are
  both acceptable). The only hard rule is that it is never `exact`; the golden helper cannot
  express a maximum confidence, so it is not asserted.
- Not asserted because the golden helper cannot express it: absence of nodes for lambdas,
  anonymous classes and fields (`java.annotations` is an array and meta uses strict equality, so
  it is skipped too).
- `mustBeTest` does not exist in the golden helper; the test file node and the two `@Test`
  methods carry `meta.isTest` in `mustContainNodes` instead.
- `file:...UserServiceTest.java -> UserService.UserService` relies on the schema rule that
  field-initializer code has the file node as `src`.
- `Order.Totals.discounted -> Money.minusPercent` goes through a parameter typed `Money`; it is
  resolved through the declared type, not skipped as a call through a function parameter.
