"""Synthetic California traffic generation model.

Importable as a plain Python package so the generation math can be unit tested
off-cluster, and installed onto serverless SDP compute via the bundle's
``environment.dependencies: [--editable ...]`` so the pipeline uses the exact
same code the tests cover.
"""

from . import config, corridors, stations, traffic_model

__all__ = ["config", "corridors", "stations", "traffic_model"]
