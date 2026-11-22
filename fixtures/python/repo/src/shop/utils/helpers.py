"""Formatting helpers."""


def format_price(value):
    return "$%.2f" % value


def slugify(text):
    return "slug-" + text


def make_formatter(prefix):
    placeholder = format_price(0)

    def _fmt(value):
        return prefix + placeholder + format_price(value)

    return _fmt


def logged(func):
    return func


@logged
def apply_discount(value, percent):
    return value - value * percent / 100
