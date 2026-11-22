"""Contains a deliberate syntax error at the end of the file."""


def healthy():
    return 1


def also_fine(x):
    return healthy() + x


def broken(:
    return 2
