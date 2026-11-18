# Route check

| serials | records | part routes | finished | finished first pass | WIP | serials of parts without a route |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 11 | 73 | 2 | 9 | 7 (77.8%) | 1 | 1 |

Order: replayed by timestamp. Rework records: 3. Records of parts without a route: 2.

## Part MTR-1P

| serials | records | route steps | required | finished | finished first pass | WIP | RTY |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 30 | 6 | 6 | 4 | 3 (75.0%) | 1 | 60.0% |

| step | units | first pass | FPY | passed (final) | fails | retests | records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SMT | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |
| AOI | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |
| ICT | 5 | 4 | 80.0% | 4 | 1 | 0 | 5 |
| FLASH | 4 | 4 | 100.0% | 4 | 0 | 0 | 4 |
| FCT | 4 | 3 | 75.0% | 4 | 1 | 1 | 5 |
| PACK | 4 | 4 | 100.0% | 4 | 0 | 0 | 4 |

## Part MTR-3P

| serials | records | route steps | required | finished | finished first pass | WIP | RTY |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 41 | 9 | 8 | 5 | 4 (80.0%) | 0 | 80.0% |

| step | units | first pass | FPY | passed (final) | fails | retests | records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SMT | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |
| AOI | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |
| ICT | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |
| FLASH | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |
| CALIB | 5 | 4 | 80.0% | 5 | 1 | 1 | 6 |
| HIPOT | 4 | 4 | 100.0% | 4 | 0 | 0 | 4 |
| BURNIN (optional) | 0 | 0 | - | 0 | 0 | 0 | 0 |
| FCT | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |
| PACK | 5 | 5 | 100.0% | 5 | 0 | 0 | 5 |

Retests = records after each unit's first record at the step. RTY = product of FPY over required steps.

## Findings: 5

| kind | count |
| --- | ---: |
| skipped-step | 1 |
| incomplete | 2 |
| unknown-part | 1 |
| part-conflict | 1 |

### Skipped steps (a later step ran, this required step never passed): 1

- U3P-002 ran FCT (row 45) but never passed HIPOT (part MTR-3P)

### Incomplete units (--complete): 2

- U1P-005 has not passed ICT, FLASH, FCT, PACK (part MTR-1P)
- U3P-002 has not passed HIPOT (part MTR-3P)

### Parts without a route: 1

- part "GW-4G" has no route (1 serial, 2 rows, first row 73); add its steps to the route file

### Serials with records for more than one part: 1

- U3P-005 has records for part MTR-1P (1 row, first row 72) but its first record is part MTR-3P; checked as MTR-3P
