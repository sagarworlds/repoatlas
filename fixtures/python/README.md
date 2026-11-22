# Python fixture

Parsed only, never executed. `repo/` is a src-layout project (`pyproject.toml` has
`[tool.setuptools.packages.find] where = ["src"]`) plus `scripts/` and `tests/` at the
repo root, so there are two package roots: `src/` and the repo root.
Expectations live in `expected-edges.json`.

| File | Purpose / what it proves |
|---|---|
| `src/shop/__init__.py` | Re-export (`from .models import Order, User`); relative import |
| `src/shop/models.py` | `Entity` base; `User(Entity)` with `super().__init__`, `super().describe()`, `self.method()` (own and inherited), `@classmethod`/`@staticmethod`/`@property`, `User(...)` with `__init__`; nested class `Order.Status`; absolute import of a function |
| `src/shop/service.py` | `from shop import User` (follows re-export); aliased import (`format_price as fp`); module alias (`import shop.models as m`, `m.Order(...)`); `x = User(..)` then `x.save()` (receiverTypeHint); `order: Order = ...` then `order.total()` (annotation hint); `User.create()` static call; `Admin(...)` with no `__init__` of its own calls the inherited `User.__init__`; subclass `Admin.promote` calls inherited methods; `Registry.get` exists to prove stoplisted names are not name-matched |
| `src/shop/billing.py` | Circular import with `service.py`; `from . import service` then `service.order_total()`; wildcard import from `shop.utils.helpers` |
| `src/shop/reports.py` | `from . import utils` (package `__init__`), `utils.shout()`; `render` defined in two unrelated classes, `report.render()` on an unknown receiver gives name-match edges to both |
| `src/shop/broken.py` | Valid functions followed by a syntax error: `parseErrors > 0`, `healthy` and `also_fine` still extracted |
| `src/shop/utils/__init__.py` | Package module defining `shout` |
| `src/shop/utils/helpers.py` | Target of absolute, aliased, wildcard and function-level imports; decorated function; nested function inside `make_formatter` |
| `src/shop/utils/net.py` | `import requests` (imports edge to `ext:pypi:requests`, no call edge even for `requests.get`); `try: import ujson ... except ImportError`; parent-relative `from ..models import User`; import inside a function; `settings.get()` on an unknown receiver (stoplisted) |
| `tests/test_service.py` | Test file (`isTest`) calling production code |
| `scripts/seed.py` | Second package root; module-level call `main()` whose `src` is the file node; `Registry()` constructor, hinted `registry.put()` |

## Choices worth knowing

- `minResolutionRate` is 0.8. Nearly every call in the fixture is resolvable. The slack
  covers `super()` itself (it may be counted as an unresolved call), `requests.get`, and
  decorator uses; docs/TESTING.md targets 65% for real-world Python.
- `parseErrorFiles` lists only `broken.py`. The golden helper requires the count of files
  with parse errors to equal this list, so no other file may have a syntax error.
- No assertion about the broken part of `broken.py`: error recovery is grammar-specific.
  `healthy` and `also_fine` come before the error and are asserted.
- Not asserted because the docs leave them open: the id and existence of the nested
  function `make_formatter._fmt` (only the outer function's call is asserted), the exact
  value of `meta["py.decorators"]` (the golden helper compares meta with strict equality,
  so arrays cannot be expressed), and `isTest` on test-file symbols (only the file node).
- Stdlib imports are avoided on purpose: they would become `ext:pypi:*` nodes and add noise.
- `mustBeUnresolved` is empty: the unresolved entry name format is plugin-defined.
