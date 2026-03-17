"""IFC 4x3 specification documentation scraper.

This module provides functionality to crawl and extract content from the official
IFC 4x3 online documentation. It systematically traverses the documentation website,
extracts textual content from HTML pages, and saves the results in multiple formats
for further processing and analysis.

Key Features:
    - Recursive web crawling with scope control
    - HTML content extraction and text cleaning
    - Rate limiting and error handling
    - Multiple output formats (JSONL and plain text)
    - Configurable crawling parameters

Output Formats:
    - JSONL: Structured JSON Lines format with URL, title, and text
    - TXT: Aggregated plain text with clear page separators

Typical Usage:
    python generate_ifc_docs.py --verbose --max-pages 1500

    Or programmatically:
    pages, jsonl_path, txt_path = crawl_ifc_docs(
        start_url=DEFAULT_START_URL,
        max_pages=1500,
        verbose=True
    )
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from typing import Iterable, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse, urlunparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    requests = None
    BeautifulSoup = None


DEFAULT_START_URL = "https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/toc.html"


def _normalize_url(u: str) -> str:
    """Normalize URL by removing fragments and normalizing path."""
    p = urlparse(u)
    p = p._replace(fragment="", query="")
    path = re.sub(r"/+", "/", p.path)
    return urlunparse((p.scheme, p.netloc, path, "", "", ""))


def _is_within_scope(url: str, base_netloc: str, allowed_prefix: Optional[str]) -> bool:
    """Check if URL is within crawling scope."""
    p = urlparse(url)

    if p.netloc and p.netloc != base_netloc:
        return False

    if allowed_prefix and not p.path.startswith(allowed_prefix):
        return False

    excluded_extensions = (
        ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg",
        ".zip", ".gz", ".mp4", ".webm", ".css", ".js"
    )
    if any(p.path.lower().endswith(ext) for ext in excluded_extensions):
        return False

    return True


def _clean_text(text: str) -> str:
    """Clean and normalize text."""
    text = text.replace("\xa0", " ").replace("\r\n", "\n")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    return text.strip()


def _extract_main_text(html: str, url: str) -> Tuple[str, str]:
    """Extract page title and main textual content from HTML.
    
    Returns: (title, text)
    """
    if not BeautifulSoup:
        raise RuntimeError("BeautifulSoup not available")
    
    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""

    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    for nav in soup.find_all("nav"):
        nav.decompose()

    nav_selectors = [
        {"class_": re.compile(r"navbar|sidenav|breadcrumb", re.I)},
        {"id": re.compile(r"navbar|sidenav|breadcrumb", re.I)},
    ]
    
    for selector in nav_selectors:
        for elem in soup.find_all(**selector):
            elem.decompose()

    main_content = None

    main_content = soup.find("main")

    if not main_content:
        main_content = soup.find("article")

    if not main_content:
        for selector in [
            {"id": re.compile(r"content|main", re.I)},
            {"class_": re.compile(r"content|main", re.I)},
        ]:
            main_content = soup.find("div", **selector)
            if main_content:
                break

    if not main_content:
        main_content = soup.find("body")

    if main_content:
        text = main_content.get_text("\n", strip=True)
    else:
        text = soup.get_text("\n", strip=True)

    text = _clean_text(text)

    if len(text) < 100:
        body = soup.find("body")
        if body:
            text = body.get_text("\n", strip=True)
            text = _clean_text(text)
    
    return title, text


def _iter_links(html: str, base_url: str) -> Iterable[str]:
    """Extract all links from HTML."""
    if not BeautifulSoup:
        return []
    
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.find_all("a", href=True):
        href = a.get("href")
        if not href:
            continue
        if href.startswith("#"):
            continue
        if href.startswith(("mailto:", "javascript:")):
            continue

        abs_url = urljoin(base_url, href)
        yield _normalize_url(abs_url)


def crawl_ifc_docs(
    start_url: str = DEFAULT_START_URL,
    out_jsonl: str = "docs/ifc4x3_spec.jsonl",
    out_txt: str = "docs/ifc4x3_spec.txt",
    max_pages: int = 1500,
    allowed_path_prefix: Optional[str] = "/IFC/RELEASE/IFC4x3/HTML/",
    delay_seconds: float = 0.1,
    timeout: int = 30,
    user_agent: str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    verbose: bool = False
) -> Tuple[int, str, str]:
    """Crawl IFC docs and write outputs.
    
    Returns: (pages_scraped, jsonl_path, txt_path)
    """
    if not requests:
        raise RuntimeError("requests is required")
    if not BeautifulSoup:
        raise RuntimeError("beautifulsoup4 is required")

    os.makedirs(os.path.dirname(out_jsonl) or ".", exist_ok=True)
    os.makedirs(os.path.dirname(out_txt) or ".", exist_ok=True)
    
    start_url = _normalize_url(start_url)
    base = urlparse(start_url)
    base_netloc = base.netloc
    
    to_visit = [start_url]
    visited: Set[str] = set()
    pages_scraped = 0
    errors = 0
    
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent})
    
    with open(out_jsonl, "w", encoding="utf-8") as f_jsonl, \
         open(out_txt, "w", encoding="utf-8") as f_txt:
        
        while to_visit and pages_scraped < max_pages:
            url = to_visit.pop(0)
            
            if url in visited:
                continue
            
            if not _is_within_scope(url, base_netloc, allowed_path_prefix):
                if verbose:
                    print(f"Skipping out-of-scope: {url}")
                visited.add(url)
                continue
            
            if verbose:
                print(f"Fetching ({pages_scraped + 1}/{max_pages}): {url}")
            
            try:
                resp = session.get(url, timeout=timeout, allow_redirects=True)
                resp.raise_for_status()

                content_type = resp.headers.get("Content-Type", "")
                if "text/html" not in content_type:
                    if verbose:
                        print(f"  Skipping non-HTML: {content_type}")
                    visited.add(url)
                    continue
                
                html = resp.text
                
            except Exception as e:
                errors += 1
                if verbose:
                    print(f"  Error fetching: {e}")
                visited.add(url)
                continue
            
            try:
                title, text = _extract_main_text(html, url)
                
                if not text or len(text) < 50:
                    if verbose:
                        print(f"  No/minimal content extracted ({len(text)} chars)")
                    visited.add(url)
                    for link in _iter_links(html, url):
                        if link not in visited and link not in to_visit:
                            if _is_within_scope(link, base_netloc, allowed_path_prefix):
                                to_visit.append(link)
                    continue
                
                record = {
                    "url": url,
                    "title": title,
                    "text": text,
                }

                f_jsonl.write(json.dumps(record, ensure_ascii=False) + "\n")
                f_jsonl.flush()

                f_txt.write("=" * 60 + "\n")
                f_txt.write(f"TITLE: {title}\n")
                f_txt.write(f"URL: {url}\n")
                f_txt.write("=" * 60 + "\n\n")
                f_txt.write(text + "\n\n")
                f_txt.flush()
                
                pages_scraped += 1
                
                if verbose:
                    print(f"  Scraped: {title} ({len(text)} chars)")
                
            except Exception as e:
                errors += 1
                if verbose:
                    print(f"  Error extracting content: {e}")
            
            visited.add(url)

            try:
                for link in _iter_links(html, url):
                    if link not in visited and link not in to_visit:
                        if _is_within_scope(link, base_netloc, allowed_path_prefix):
                            to_visit.append(link)
            except Exception as e:
                if verbose:
                    print(f"  Error extracting links: {e}")

            if delay_seconds > 0:
                time.sleep(delay_seconds)
        
        if verbose:
            print(f"\nFinished: {pages_scraped} pages scraped, {errors} errors")
    
    return pages_scraped, os.path.abspath(out_jsonl), os.path.abspath(out_txt)


def parse_args(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Scrape IFC 4x3 documentation")
    p.add_argument("--start-url", default=DEFAULT_START_URL, help="Starting URL")
    p.add_argument("--out-jsonl", default="docs/ifc4x3_spec.jsonl", help="Output JSONL")
    p.add_argument("--out-txt", default="docs/ifc4x3_spec.txt", help="Output TXT")
    p.add_argument("--max-pages", type=int, default=1500, help="Max pages to crawl")
    p.add_argument("--allowed-prefix", default="/IFC/RELEASE/IFC4x3/HTML/", 
                   help="URL path prefix filter")
    p.add_argument("--delay", type=float, default=0.1, help="Delay between requests")
    p.add_argument("--timeout", type=int, default=30, help="Request timeout")
    p.add_argument("--user-agent", default="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                   help="User-Agent header")
    p.add_argument("-v", "--verbose", action="store_true", help="Verbose output")
    return p.parse_args(argv)


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = parse_args(argv)
    
    try:
        pages, jsonl_path, txt_path = crawl_ifc_docs(
            start_url=args.start_url,
            out_jsonl=args.out_jsonl,
            out_txt=args.out_txt,
            max_pages=args.max_pages,
            allowed_path_prefix=args.allowed_prefix or None,
            delay_seconds=args.delay,
            timeout=args.timeout,
            user_agent=args.user_agent,
            verbose=args.verbose
        )
    except Exception as e:
        sys.stderr.write(f"[ERROR] Failed: {e}\n")
        return 1
    
    print(f"Scraped {pages} pages")
    print(f"JSONL: {jsonl_path}")
    print(f"TXT:   {txt_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())