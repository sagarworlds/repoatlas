import requests

from app.helpers import build_url


def fetch(path):
    return requests.get(build_url(path))


def main():
    return fetch("health")
