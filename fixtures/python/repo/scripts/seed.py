"""Seed script. Lives outside src/, so the repo root is a second package root."""
from shop import User
from shop.service import Registry, register


def main():
    registry = Registry()
    user = User.create("seed")
    registry.put("seed", user)
    return register("seed")


if __name__ == "__main__":
    main()
