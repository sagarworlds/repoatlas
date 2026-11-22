"""Billing. It imports service and service imports it: a deliberate cycle."""
from . import service
from shop.utils.helpers import *


def charge(user, amount):
    label = slugify(user.name)
    return label + format_price(amount)


def refund(order_id):
    return service.order_total(order_id)
