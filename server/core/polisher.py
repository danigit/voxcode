"""
VoxCode Text Polisher Subsystem (core/polisher.py).

Provides deterministic regex-based cleaners to format transcribed speech before
typing or saving to vault notes:
- Strips hallucinated Whisper tags (e.g. [BLANK_AUDIO], (music))
- Eliminates repeated stutter words (e.g. "the the" -> "the")
- Fixes sentence capitalization and terminal punctuation spacing
- Formats standard symbols and quotation marks
"""

from __future__ import annotations

import re

# Filter tags produced by Whisper on silence or music
TAG_PATTERN = re.compile(
    r"\[(?:BLANK_AUDIO|MUSIC|LAUGHTER|APPLAUSE|SILENCE|NOISE|SOUND)\]|\((?:music|laughter|applause)\)",
    re.IGNORECASE,
)

# Common duplicated filler words: "the the", "I I", "and and", etc.
STUTTER_PATTERN = re.compile(r"\b([a-zA-Z]{1,10})\s+\1\b", re.IGNORECASE)

# Speech hesitation & filler words: "um", "uh", "erm", "err", "mm-hmm", "uh-huh", "mhm"
# Note: Valid standalone words like "er" (German pronoun "he", "ER diagram") and "ah" (Ampere-hour)
# are preserved; only elongated hesitations (err, ahh) or standard fillers are stripped.
FILLER_PATTERN = re.compile(
    r",?\s*\b(?:um+|uh+|erm+|err+|umm+|uhh+|ah{2,}|er{2,}|mm[-_]?hmm|uh[-_]?huh|mhm)\b[,.:;?!]?",
    re.IGNORECASE,
)

# Punctuation spacing cleanup: "hello , world" -> "hello, world"
PUNCT_SPACE_PATTERN = re.compile(r"\s+([,.:;?!])")

# Multiple consecutive commas or comma followed by period: ", ," or ", ."
CONSECUTIVE_PUNCT_PATTERN = re.compile(r"([,;:])\s*[,;:]+")

# Multiple whitespace
MULTI_SPACE_PATTERN = re.compile(r"\s+")


def remove_filler_words(text: str) -> str:
    """Removes verbal filler hesitations like 'um', 'uh', 'mm-hmm' without affecting normal vocabulary."""
    if not text:
        return ""
    # Strip filler tokens
    cleaned = FILLER_PATTERN.sub("", text)
    # Clean dangling consecutive punctuation left by removed fillers (e.g. "so, um, yeah" -> "so, yeah")
    cleaned = CONSECUTIVE_PUNCT_PATTERN.sub(r"\1", cleaned)
    # Clean leading punctuation if first word was filler (e.g. "Um, hello" -> "hello")
    cleaned = re.sub(r"^\s*[,;:]\s*", "", cleaned)
    return cleaned


def polish_text(raw_text: str, auto_capitalize: bool = True, remove_fillers: bool = True) -> str:
    """
    Cleans, normalizes, and polishes raw speech-to-text transcriptions.
    """
    if not raw_text:
        return ""

    # Remove whisper noise tags
    text = TAG_PATTERN.sub("", raw_text)

    # Clean double spaces
    text = MULTI_SPACE_PATTERN.sub(" ", text).strip()

    # Eliminate immediate repeated stutters (run twice for triple stutters)
    text = STUTTER_PATTERN.sub(r"\1", text)
    text = STUTTER_PATTERN.sub(r"\1", text)

    # Remove verbal fillers if enabled
    if remove_fillers:
        text = remove_filler_words(text)

    # Clean spacing before punctuation marks
    text = PUNCT_SPACE_PATTERN.sub(r"\1", text)

    # Clean multi-spaces again after removals
    text = MULTI_SPACE_PATTERN.sub(" ", text).strip()

    # Capitalize first character if enabled
    if auto_capitalize and text:
        # Find first alphanumeric character
        for idx, ch in enumerate(text):
            if ch.isalnum():
                text = text[:idx] + ch.upper() + text[idx + 1:]
                break

    return text.strip()
