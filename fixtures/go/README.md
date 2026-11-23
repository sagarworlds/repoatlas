# Go fixture

Parsed only, never executed or compiled. `repo/` is a module `example.com/shop` (`go.mod`)
with 14 `.go` files in five packages. Expectations live in `expected-edges.json`.

## Conventions the plugin should follow

- Ids: files `file:{path}`; symbols `sym:{path}#{Receiver.Method | Name}`; one module node
  per Go package `mod:go:{go.mod module path}/{dir}` (root package = module path).
- Internal package imports emit `file -> mod:go:...` (never file -> file). Standard library
  imports emit `file -> ext:go:stdlib`; third party `file -> ext:go:github.com/google/uuid`.
- The `util` import in `cmd/shop/main.go` is aliased (`u`), `internal/model` is a dot import,
  `internal/plugins` a blank import. `internal/model` declares `package models`, so the
  default binding name is `models` (from the target package), not `model`.
- Struct and interface embedding emit `extends` (also for the qualified `*models.User` and the
  pointer `*Server`); `implements` is never emitted.
- Constructor inference: `x := NewT(...)` takes its type from the signature text
  (`func NewServer(addr string, h Handler) *Server`).
- `_test.go` files get `isTest`; the external test package `service_test` imports
  `.../internal/service` like any other package.

## Files

| File | What it proves |
|---|---|
| `cmd/shop/main.go` | Dot, blank and aliased imports; `&service.Server{}` then `srv.Shutdown()` (composite literal hint, method declared in another file); `service.NewServer()` then `server.Start()` (cross-package constructor inference); `go worker(...)`, `defer cleanup()`; method value `server.Stop` is not a call; `fmt`/`os`/`time` produce no call edges |
| `cmd/shop/helpers.go` | Package-scope calls without import; call inside a function literal attributed to `process`; `handler(job)` on a local func variable is expected to stay unresolved |
| `internal/model/user.go` | `package models` in dir `model`; `u.Validate()` via receiver; unexported `normalize` |
| `internal/model/order.go` | `type ID int` (`go.kind` = `alias`); `User.Orders` is a method of `User` declared in another file and calls `u.Validate()`; `o.Owner.Display()` on a field chain is deliberately not asserted |
| `internal/model/admin.go` | `Admin` embeds `User`; `a.Display()` is an inherited call (inferred, through `extends`) |
| `internal/plugins/register.go` | `init()` in a package only imported for side effects |
| `internal/service/server.go` | `AuditedServer` embeds `*Server`, `a.Stop()` promoted; `go s.serveLoop()`, `defer s.Stop()`; `s.handler.Serve()` ambiguous; `net/http`, `fmt` stdlib |
| `internal/service/client.go` | `Server.Shutdown` declared away from `Server`; `Session` embeds qualified `*models.User` and `sess.Display()` is inherited; `c := NewClient(..)` then `c.Do()`; `init()` #1 |
| `internal/service/handler.go` | Interfaces, interface embedding (`HandlerCloser`), two structural implementers of `Handler` (unnamed receiver on `EchoHandler`), `h.Serve()` through an interface variable, `init()` #2 |
| `internal/service/service_test.go` | Test in the same package (`isTest`) calling the package under test |
| `internal/service/external_test.go` | External test package `service_test`, qualified calls |
| `internal/util/strings.go` | Generic `Map`; `Join` calls `strings.Join` (must not become a self call); `normalize` name collision with `models`; `Ping` |
| `internal/util/ids.go` | `uuid.NewString()` (third party, import edge only); `Pong` and `Ping` call each other across files |
| `internal/util/broken.go` | `Fine` and `AlsoFine` precede a syntax error: `parseErrors > 0`, both still extracted |

## Choices worth knowing

- `minResolutionRate` is 0.8. Of roughly 38 counted calls, the expected leftovers are
  `handler(job)` (local func variable), possibly `s.handler.Serve` / `h.Serve` (ambiguous
  between two implementers: name-match or unresolved are both acceptable) and `o.Owner.Display`.
- `parseErrorFiles` lists only `internal/util/broken.go` (the golden helper requires the
  count to match exactly). Nothing is asserted about the broken function itself.
- Dispatch through `h.Serve()` is intentionally absent from `mustContainEdges` and from
  `mustNotContainEdges`: the plugin may emit name-match edges to both implementers or leave
  it unresolved, but must not emit an exact edge.
- `mustNotContainEdges` covers: no call edges to `ext:go:stdlib` or uuid, no leak between the
  two unrelated `normalize` functions, `util.Join` not calling itself, the method value
  `server.Stop` not counting as a call, and no `implements` edges.
- Not tracked in v1: function values passed as arguments (`u.Shout`, `server.Stop`), `replace`
  directives, field-chain receiver types.
