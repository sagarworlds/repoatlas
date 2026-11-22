"""Application services."""
from shop import User
from shop.models import Order
from shop.utils.helpers import format_price as fp
import shop.models as m
from .billing import charge


class Registry:
    """Tiny key/value store; get/put collide with common builtin names on purpose."""

    def __init__(self):
        self.items = {}

    def get(self, key):
        return self.items[key]

    def put(self, key, value):
        self.items[key] = value


class Admin(User):
    """A privileged user. It has no __init__ of its own."""

    def promote(self):
        self.save()
        return self.touch()


def load_order(order_id):
    owner = User("loader")
    return Order(owner, order_id)


def order_total(order_id):
    order: Order = load_order(order_id)
    return order.total()


def register(name):
    user = User(name)
    user.save()
    return charge(user, 10)


def register_admin(name):
    return Admin(name)


def create_via_alias(name):
    return m.Order(User.create(name))


def price_label(order_id):
    return fp(order_total(order_id))
