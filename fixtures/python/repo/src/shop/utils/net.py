"""Network helpers."""
import requests

try:
    import ujson as json_impl
except ImportError:
    json_impl = None

from ..models import User


def fetch_user(url):
    response = requests.get(url)
    return User(response.text)


def timeout_for(settings):
    return settings.get("timeout")


def lazy_slug(url):
    from shop.utils.helpers import slugify

    return slugify(url)
