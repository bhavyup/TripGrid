# TripGrid — Out-of-Core Analytics Engine

Analytical query engine over the NYC TLC Yellow Taxi dataset (~49M trips/year,
~1.5B rows full history) that runs under a hard memory ceiling on data that does
not fit in RAM. Vectorised NumPy kernels, partition pruning, chunked parallel
execution — benchmarked against pandas and DuckDB, with a correctness gate on
every benchmark query.

Design: see docs/DESIGN.md. Status: M0 (scaffold + ingest) next.
