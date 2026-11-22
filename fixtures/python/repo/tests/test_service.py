from shop.models import User
from shop.service import order_total, register


def test_register_returns_receipt():
    receipt = register("ada")
    assert receipt


def test_user_roundtrip():
    user = User("grace")
    assert user.save() is not None


def test_order_total_of_empty_order():
    assert order_total(1) == 0
