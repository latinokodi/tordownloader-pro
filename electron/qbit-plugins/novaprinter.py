"""
Shim for qBittorrent's novaprinter module.
Replaces prettyPrinter() to capture results into a per-search accumulator
instead of printing to stdout in qBittorrent's wire format.
"""

import threading

# ── Result accumulator ─────────────────────────────────
# Engines are searched concurrently, one per worker thread, and every engine
# reports through the module-level prettyPrinter(). A single shared list let
# one engine's clear_results() wipe another engine's in-flight results, so each
# search now gets its own accumulator keyed by thread.
#
# Engines that fan their own page fetches out into child threads (e.g.
# torrentdownloads) must still land in the parent engine's result set, so
# Thread.start is wrapped once to make children inherit the parent accumulator.

_by_thread: dict = {}
_unbound = threading.local()  # isolates stray threads instead of mixing them


def _current() -> list:
    """Return the accumulator bound to the calling thread."""
    acc = _by_thread.get(threading.get_ident())
    if acc is None:
        acc = getattr(_unbound, 'results', None)
        if acc is None:
            acc = []
            _unbound.results = acc
    return acc


def prettyPrinter(data: dict) -> None:
    """Capture a search result dict into the current engine's results."""
    _current().append(dict(data))


def clear_results() -> None:
    """Reset the current engine's accumulator."""
    del _current()[:]


def get_results() -> list:
    """Return all results captured for the current engine."""
    return list(_current())


class collect_results:
    """Bind a fresh accumulator to the calling thread for one engine search.

    Used as a context manager, and any thread started inside the block
    inherits the same accumulator::

        with collect_results() as acc:
            plugin.search(query)
    """

    def __init__(self) -> None:
        self._tid = threading.get_ident()
        self._previous = _by_thread.get(self._tid)
        self.results: list = []

    def __enter__(self) -> list:
        _by_thread[self._tid] = self.results
        return self.results

    def __exit__(self, *_exc) -> bool:
        if self._previous is None:
            _by_thread.pop(self._tid, None)
        else:
            _by_thread[self._tid] = self._previous
        return False


def _install_thread_inheritance() -> None:
    """Make threads started by an engine report into that engine's results."""
    original_start = threading.Thread.start
    if getattr(original_start, '_qbit_inherits_results', False):
        return  # already installed

    def start_inheriting(self, *args, **kwargs):
        parent_acc = _current()
        inner_run = self.run

        def run_inheriting():
            tid = threading.get_ident()
            previous = _by_thread.get(tid)
            _by_thread[tid] = parent_acc
            try:
                inner_run()
            finally:
                if previous is None:
                    _by_thread.pop(tid, None)
                else:
                    _by_thread[tid] = previous

        self.run = run_inheriting
        return original_start(self, *args, **kwargs)

    start_inheriting._qbit_inherits_results = True
    threading.Thread.start = start_inheriting


_install_thread_inheritance()


def anySizeToBytes(size_string: str) -> int:
    """Convert a size string (e.g. '1.5 GB', '500 MB') to bytes.
    
    This is a standard function provided by qBittorrent's novaprinter.
    Many community plugins depend on it.
    """
    size_string = size_string.strip().upper()
    if not size_string:
        return -1

    # Split into value and unit
    parts = size_string.split()
    if len(parts) < 1:
        return -1

    try:
        value = float(parts[0])
    except ValueError:
        return -1

    if len(parts) >= 2:
        unit = parts[1]
    else:
        unit = 'B'  # Assume bytes if no unit

    multipliers = {
        'B': 1,
        'KB': 1024,
        'KIB': 1024,
        'MB': 1024 ** 2,
        'MIB': 1024 ** 2,
        'GB': 1024 ** 3,
        'GIB': 1024 ** 3,
        'TB': 1024 ** 4,
        'TIB': 1024 ** 4,
    }
    multiplier = multipliers.get(unit.replace('YTES', '').strip(), 1)  # handle 'BYTES' → 'B'
    return int(value * multiplier)


class SearchResults(dict):
    """qBittorrent SearchResults placeholder.
    Some community plugins create instances of this class.
    It behaves like a dict but also supports attribute access."""
    def __getattr__(self, name):
        if name in self:
            return self[name]
        raise AttributeError(f"'SearchResults' has no attribute '{name}'")
    
    def __setattr__(self, name, value):
        self[name] = value
