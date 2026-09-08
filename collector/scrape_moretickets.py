#!/usr/bin/env python3
"""Scrape public MoreTickets pick-seat pages and optionally persist snapshots to Supabase."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests
from playwright.async_api import Page, async_playwright


def parse_ids(url: str) -> dict[str, str | None]:
    parsed = urlparse(url)
    if not parsed.hostname or not parsed.hostname.endswith("moretickets.com"):
        raise ValueError("Only MoreTickets URLs are supported")
    query = parse_qs(parsed.query)
    session_id = (query.get("sessionId") or [None])[0]
    show_id = (query.get("showId") or [None])[0]
    tour_id = (query.get("tourId") or [None])[0]
    if not session_id or not show_id:
        raise ValueError("URL must contain sessionId and showId")
    return {"session_id": session_id, "show_id": show_id, "tour_id": tour_id}


async def collect_visible_cards(page: Page, collected: dict[str, dict]) -> None:
    cards = await page.locator(".ticket.hasColor.pc").evaluate_all(
        """els => els.map(el => ({
          inventory_id: el.getAttribute('data-inventory-id'),
          color: el.style.getPropertyValue('--ticket-color').trim(),
          area_name: (el.querySelector('.ticket-title')?.textContent || '').trim(),
          seat_info: (el.querySelector('.seat')?.textContent || '').trim(),
          sale_price: Number((el.querySelector('.discount-price')?.textContent || '').replace(/[^0-9.]/g, '')),
          delivery_text: (el.querySelector('.issue-text')?.textContent || '').trim()
        }))"""
    )
    for card in cards:
        if card.get("inventory_id") and card.get("sale_price"):
            collected[card["inventory_id"]] = card


async def scrape(url: str) -> dict:
    ids = parse_ids(url)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000}, locale="en-US")
        await page.goto(url, wait_until="domcontentloaded", timeout=90_000)
        await page.locator(".ticket.hasColor.pc").first.wait_for(state="visible", timeout=90_000)

        show_name = (await page.locator(".tour-name").first.inner_text()).strip()
        session_text = (await page.locator(".date-time").first.inner_text()).strip()
        venue = ""
        for selector in (".venue-name", ".show-venue", ".address", "[class*='venue']"):
            locator = page.locator(selector).first
            if await locator.count():
                value = (await locator.inner_text()).strip()
                if value:
                    venue = value
                    break
        count_text = (await page.locator(".inventory-count").first.inner_text()).strip()
        count_match = re.search(r"([\d,]+)", count_text)
        listing_count = int(count_match.group(1).replace(",", "")) if count_match else 0

        zones = await page.locator(".zone").evaluate_all(
            """els => els.map(el => ({
              color: el.style.getPropertyValue('--zone-color').trim(),
              face_name: (el.querySelector('.zone-name')?.textContent || '').trim(),
              minimum_text: (el.querySelector('.price')?.textContent || '').trim()
            }))"""
        )
        color_to_zone = {zone["color"]: zone for zone in zones}
        for zone in zones:
            values = re.findall(r"\d+(?:\.\d+)?", zone["face_name"])
            prices = re.findall(r"\d+(?:\.\d+)?", zone["minimum_text"])
            zone["face_value"] = float(values[-1]) if values else None
            zone["minimum_price"] = float(prices[-1]) if prices else None

        collected: dict[str, dict] = {}
        list_selector = ".pc-ticket-list"
        unchanged = 0
        last_size = -1
        for _ in range(80):
            await collect_visible_cards(page, collected)
            if len(collected) == last_size:
                unchanged += 1
            else:
                unchanged = 0
                last_size = len(collected)
            if listing_count and len(collected) >= listing_count:
                break
            if unchanged >= 5:
                break
            await page.locator(list_selector).evaluate("el => { el.scrollTop += Math.max(el.clientHeight * .8, 500) }")
            await page.wait_for_timeout(350)

        collected_at = datetime.now(timezone.utc).isoformat()
        listings = []
        for card in collected.values():
            zone = color_to_zone.get(card.pop("color"), {})
            card.update(
                face_name=zone.get("face_name"),
                face_value=zone.get("face_value"),
                collected_at=collected_at,
            )
            listings.append(card)
        listings.sort(key=lambda item: item["sale_price"])
        market_min = min((item["sale_price"] for item in listings), default=None)
        currency = "HK$" if any("HK$" in zone["minimum_text"] for zone in zones) else "¥"
        await browser.close()

    date_match = re.search(r"(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?", session_text)
    time_match = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", session_text)
    session_date = ""
    session_weekday = ""
    parsed_date = None
    if date_match:
        session_date = f"{int(date_match.group(1)):04d}-{int(date_match.group(2)):02d}-{int(date_match.group(3)):02d}"
        parsed_date = datetime.strptime(session_date, "%Y-%m-%d")
    else:
        english_date = re.search(
            r"\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b",
            session_text,
            re.IGNORECASE,
        )
        if english_date:
            candidate = re.sub(r"\s+", " ", english_date.group(0).replace(",", "")).strip()
            for fmt in ("%b %d %Y", "%B %d %Y"):
                try:
                    parsed_date = datetime.strptime(candidate, fmt)
                    session_date = parsed_date.strftime("%Y-%m-%d")
                    break
                except ValueError:
                    continue
    if parsed_date:
        session_weekday = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][parsed_date.weekday()]

    session_time = ""
    if time_match:
        hour = int(time_match.group(1))
        minute = time_match.group(2)
        suffix = session_text[time_match.end():time_match.end() + 4].strip().upper()
        if suffix.startswith("PM") and hour < 12:
            hour += 12
        elif suffix.startswith("AM") and hour == 12:
            hour = 0
        session_time = f"{hour:02d}:{minute}"

    return {
        **ids,
        "source_url": url,
        "show_name": show_name,
        "session_text": session_text,
        "session_date": session_date,
        "session_time": session_time,
        "session_weekday": session_weekday,
        "venue": venue,
        "currency": currency,
        "listing_count": listing_count,
        "loaded_listing_count": len(listings),
        "market_min_price": market_min,
        "collected_at": collected_at,
        "tiers": zones,
        "listings": listings,
    }


def upload_to_supabase(snapshot: dict) -> None:
    base_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_KEY"]
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    snapshot_row = {key: snapshot[key] for key in (
        "session_id", "show_id", "show_name", "session_text", "currency",
        "listing_count", "loaded_listing_count", "market_min_price", "collected_at",
    )}
    snapshot_row["raw_summary"] = {"source_url": snapshot["source_url"], "tiers": snapshot["tiers"]}
    response = requests.post(f"{base_url}/rest/v1/ticket_snapshots", headers=headers, json=snapshot_row, timeout=30)
    response.raise_for_status()
    snapshot_id = response.json()[0]["id"]
    listing_rows = [{**item, "snapshot_id": snapshot_id} for item in snapshot["listings"]]
    if listing_rows:
        listing_response = requests.post(
            f"{base_url}/rest/v1/ticket_listings",
            headers={**headers, "Prefer": "return=minimal,resolution=ignore-duplicates"},
            json=listing_rows,
            timeout=60,
        )
        listing_response.raise_for_status()


def site_endpoint(site_url: str, path: str) -> str:
    return f"{site_url.rstrip('/')}{path}"


def load_site_targets(site_url: str) -> list[str]:
    response = requests.get(site_endpoint(site_url, "/api/shared-state"), timeout=30)
    response.raise_for_status()
    state = response.json()
    if not state.get("initialized"):
        raise RuntimeError("票价雷达共享数据库尚未初始化，请先打开网站一次")
    return [target["url"] for target in state.get("targets", []) if target.get("url")]


def upload_to_site(site_url: str, snapshot: dict) -> None:
    response = requests.post(
        site_endpoint(site_url, "/api/collector/snapshot"),
        json=snapshot,
        timeout=60,
    )
    if not response.ok:
        raise RuntimeError(f"网站拒绝了抓取结果：{response.status_code} {response.text[:300]}")
    try:
        result = response.json()
    except requests.JSONDecodeError as error:
        raise RuntimeError(f"网站返回的不是有效确认信息：{response.text[:300]}") from error
    if not result.get("ok"):
        raise RuntimeError(f"网站未确认抓取结果：{response.text[:300]}")
    print(f"Uploaded {snapshot['session_id']} to {site_url}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?", help="One MoreTickets pick-seat URL")
    parser.add_argument("--targets", type=Path, help="JSON file containing monitoring URLs")
    parser.add_argument("--output", type=Path, default=Path("latest_snapshot.json"))
    parser.add_argument("--upload", action="store_true", help="Upload to Supabase using environment variables")
    parser.add_argument("--from-site", action="store_true", help="Read all active monitoring URLs from the shared website")
    parser.add_argument("--upload-site", action="store_true", help="Upload each snapshot to the shared website database")
    parser.add_argument("--site-url", default=os.getenv("RADAR_SITE_URL", "https://ticket-price-radar.weichenliu44.workers.dev"))
    args = parser.parse_args()

    urls = [args.url] if args.url else []
    if args.targets:
        targets = json.loads(args.targets.read_text(encoding="utf-8"))
        urls.extend(item["url"] for item in targets if item.get("enabled", True))
    if args.from_site:
        urls.extend(load_site_targets(args.site_url))
    urls = list(dict.fromkeys(urls))
    if not urls:
        parser.error("provide a URL or --targets file")

    snapshots = []
    failures = []
    for url in urls:
        try:
            snapshot = await scrape(url)
            snapshots.append(snapshot)
            if args.upload:
                upload_to_supabase(snapshot)
            if args.upload_site:
                upload_to_site(args.site_url, snapshot)
            print(f"Collected {snapshot['show_name']} · {snapshot['session_id']}")
        except Exception as error:
            failures.append((url, str(error)))
            print(f"FAILED {url}: {error}")
    args.output.write_text(json.dumps(snapshots, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(snapshots)} snapshot(s) to {args.output}")
    if failures:
        raise SystemExit(f"{len(failures)} monitoring target(s) failed")


if __name__ == "__main__":
    asyncio.run(main())
