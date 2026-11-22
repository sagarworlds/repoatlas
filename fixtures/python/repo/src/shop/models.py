"""Domain models for the shop."""
from shop.utils.helpers import format_price


class Entity:
    """Base class for everything that has an id."""

    def __init__(self, entity_id):
        self.entity_id = entity_id

    def describe(self):
        return "entity %s" % self.entity_id

    def touch(self):
        return self.describe()


class User(Entity):
    """A customer account."""

    def __init__(self, name, entity_id=0):
        super().__init__(entity_id)
        self.name = name

    @classmethod
    def create(cls, name):
        return User(name)

    @staticmethod
    def normalize(name):
        return "user:" + name

    @property
    def display_name(self):
        return "@" + self.name

    def validate(self):
        return self.normalize(self.name) != ""

    def save(self):
        self.validate()
        return self.touch()

    def describe(self):
        base = super().describe()
        return base + " (user " + self.name + ")"


class Order(Entity):
    """An order with line items."""

    class Status:
        """Nested class: order lifecycle labels."""

        NEW = "new"

        def label(self):
            return self.NEW

    def __init__(self, owner, entity_id=0):
        super().__init__(entity_id)
        self.owner = owner
        self.lines = []

    def add_line(self, sku, price):
        self.lines.append((sku, price))

    def total(self):
        total = 0
        for _, price in self.lines:
            total += price
        return total

    def summary(self):
        return format_price(self.total())
