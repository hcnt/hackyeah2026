"""Consent texts shown before "I'm going". The version a client shows is the version it signs.

Add a new version here (and to Settings.oracle_consent_versions) instead of editing an old one: a signed join
message refers to the exact text the attendee saw.
"""

CONSENT_TEXTS: dict[str, str] = {
    "2026-10-03": (
        "Use your face to get paid at this event?\n\n"
        "We create a face signature from three photos and use it only to recognise you at this event. "
        "The photos are not stored. The signature is deleted when the event ends or when you leave, "
        "and you can leave at any time. You can attend without this."
    ),
}
