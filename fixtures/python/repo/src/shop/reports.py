"""Report renderers. Two unrelated classes share the method name render."""
from . import utils


class CsvReport:
    def render(self, rows):
        return utils.shout("csv")


class HtmlReport:
    def render(self, rows):
        return "<table></table>"


def export(report, rows):
    return report.render(rows)
