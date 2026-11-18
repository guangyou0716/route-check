# Route check

| serials | records | route steps | required | finished | finished first pass | WIP | RTY |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 62 | 4 | 4 | 12 | 6 (50.0%) | 0 | 55.6% |

Order: replayed by timestamp. Rework records: 7.

## Yield per step

| step | units | first pass | FPY | passed (final) | fails | retests | records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SMT | 12 | 12 | 100.0% | 12 | 0 | 0 | 12 |
| ICT | 12 | 10 | 83.3% | 12 | 2 | 2 | 14 |
| FCT | 12 | 8 | 66.7% | 12 | 5 | 5 | 17 |
| PACK | 12 | 12 | 100.0% | 12 | 0 | 0 | 12 |

## Dwell between steps

Per unit: from its latest pass at the first step to its first record at the second; over the limit = finding.

| steps | limit | units | exceeded | median | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| ICT > FCT | 20m | 12 | 0 | 14m | 14m |
| SMT > PACK | 50m | 12 | 6 | 56m30s | 1h40m |

Retests = records after each unit's first record at the step. RTY = product of FPY over required steps.

## Findings: 6

| kind | count |
| --- | ---: |
| dwell-exceeded | 6 |

### Dwell over the limit between steps (--max-dwell): 6

- PCB-102 reached PACK (row 11) 1h11m after passing SMT (row 6); limit 50m
- PCB-104 reached PACK (row 21) 1h11m after passing SMT (row 16); limit 50m
- PCB-106 reached PACK (row 31) 1h11m after passing SMT (row 26); limit 50m
- PCB-108 reached PACK (row 41) 1h11m after passing SMT (row 36); limit 50m
- PCB-109 reached PACK (row 48) 1h11m after passing SMT (row 42); limit 50m
- PCB-111 reached PACK (row 59) 1h40m after passing SMT (row 52); limit 50m
