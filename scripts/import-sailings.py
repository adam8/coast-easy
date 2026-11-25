"""Build Coast Easy's offline timetable from a BC Ferries GTFS ZIP."""
import csv
import io
import json
import re
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from zipfile import ZipFile

SOURCE = "https://data.trilliumtransit.com/gtfs/bcferries-bc-ca/bcferries-bc-ca.zip"
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
TERMINALS = {
    "Comox (Little River)": "CMX",
    "Departure Bay (Nanaimo)": "NAN",
    "Duke Point (Nanaimo)": "DUK",
    "Earls Cove (Sechelt)": "ERL",
    "Horseshoe Bay (Vancouver)": "HSB",
    "Langdale (Sunshine Coast)": "LNG",
    "Powell River (Westview)": "PWR",
    "Saltery Bay (Powell River)": "SLT",
    "Vancouver (Tsawwassen)": "TSA",
    "Victoria (Swartz Bay) Berth 2": "SWB",
}
CROSSINGS = (
    ("NAN", "HSB", ("Horseshoe Bay", "Departure Bay")),
    ("TSA", "SWB", ("Tsawwassen", "Swartz Bay")),
    ("TSA", "DUK", ("Tsawwassen", "Duke Point")),
    ("HSB", "LNG", ("Horseshoe Bay", "Langdale")),
    ("CMX", "PWR", ("Little River", "Westview")),
    ("SLT", "ERL", ("Earls Cove", "Saltery Bay")),
)


def gtfs_date(value):
    return date.fromisoformat(f"{value[:4]}-{value[4:6]}-{value[6:8]}")


def minutes(clock):
    hours, mins, _ = map(int, clock.split(":"))
    return 60 * hours + mins


def trip_exceptions(short_name):
    # The BC Ferries feed uses trip_short_name for per-trip date exceptions.
    if not re.fullmatch(r"[12]-\d{8}(?:,[12]-\d{8})*", short_name):
        return {}
    return {gtfs_date(entry[2:]): entry[0] for entry in short_name.split(",")}


def build(archive):
    def rows(name):
        with archive.open(name + ".txt") as raw:
            return list(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig")))

    routes = rows("routes")
    terminals_by_route = {}
    for origin, destination, names in CROSSINGS:
        route, = [row for row in routes if all(name in row["route_long_name"] for name in names)]
        terminals_by_route[route["route_id"]] = {origin, destination}
    trips = [t for t in rows("trips") if t["route_id"] in terminals_by_route]
    trip_ids = {t["trip_id"] for t in trips}
    stops = {row["stop_id"]: row["stop_name"] for row in rows("stops")}
    stop_times = defaultdict(list)
    for row in rows("stop_times"):
        if row["trip_id"] in trip_ids:
            stop_times[row["trip_id"]].append(row)

    crossings = defaultdict(list)
    for trip in trips:
        sequence = sorted(stop_times[trip["trip_id"]], key=lambda row: int(row["stop_sequence"]))
        start, end = sequence[0], sequence[-1]
        origin = TERMINALS.get(stops[start["stop_id"]])
        destination = TERMINALS.get(stops[end["stop_id"]])
        # GTFS can file exceptions to other terminals under the parent route.
        if {origin, destination} != terminals_by_route[trip["route_id"]]:
            continue
        depart, arrive = minutes(start["departure_time"]), minutes(end["arrival_time"])
        if arrive <= depart:
            raise ValueError(f"Invalid crossing times for {trip['trip_id']}")
        dates = trip_exceptions(trip.get("trip_short_name") or "")
        crossings[trip["service_id"]].append((origin + destination, depart, arrive, dates))

    calendars = {row["service_id"]: row for row in rows("calendar")}
    exceptions = {
        (row["service_id"], gtfs_date(row["date"])): row["exception_type"]
        for row in rows("calendar_dates")
    }
    info = rows("feed_info")[0]
    first, last = gtfs_date(info["feed_start_date"]), gtfs_date(info["feed_end_date"])
    matched = {
        direction: defaultdict(set)
        for origin, destination, _ in CROSSINGS
        for direction in (origin + destination, destination + origin)
    }
    day = first
    while day <= last:
        for service, options in crossings.items():
            exception = exceptions.get((service, day))
            calendar = calendars.get(service)
            regular = calendar and not calendar.get("service_name", "").startswith("Exception Only") and (
                calendar[WEEKDAYS[day.weekday()]] == "1" and
                gtfs_date(calendar["start_date"]) <= day <= gtfs_date(calendar["end_date"])
            )
            for direction, depart, arrive, dates in options:
                override = dates.get(day, exception)
                if override == "1" or (override != "2" and regular):
                    calendar_date = day + timedelta(days=depart // 1440)
                    if calendar_date <= last:
                        offset = depart // 1440 * 1440
                        matched[direction][calendar_date.isoformat()].add((depart - offset, arrive - offset))
        day += timedelta(days=1)
    missing = [direction for direction, days in matched.items() if not days]
    if missing:
        raise ValueError(f"Missing timetables for {', '.join(missing)}")
    return {
        "source": SOURCE, "feedVersion": info["feed_version"],
        "validFrom": first.isoformat(), "validTo": last.isoformat(),
        "directions": {
            direction: {day: sorted(times) for day, times in sorted(days.items())}
            for direction, days in matched.items()
        },
    }


if __name__ == "__main__":
    with ZipFile(sys.argv[1]) as archive:
        result = build(archive)
    output = Path(__file__).resolve().parent.parent / "public/sailings-schedule.json"
    output.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
