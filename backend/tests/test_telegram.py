import json
from urllib.parse import parse_qsl, urlencode

import pytest


def verify(data, settings, now=100000):
    from app.services.telegram import verify_telegram_init_data

    return verify_telegram_init_data(data, settings.bot_token.get_secret_value(), now=now)


@pytest.mark.parametrize("fields", [{}, {"signature": "modern-base64url_signature"}])
def test_valid_hmac_profile_and_modern_signature(telegram_init_data, settings, fields):
    profile = verify(telegram_init_data(auth_date=100000, fields=fields), settings)
    assert profile.username == "alice"
    assert profile.avatar_url is None
    assert not hasattr(profile, "user_id")


@pytest.mark.parametrize("age", [-31, 86401])
def test_invalid_auth_date(telegram_init_data, settings, age):
    with pytest.raises(ValueError, match="Invalid Telegram profile"):
        verify(telegram_init_data(auth_date=100000 - age), settings)


@pytest.mark.parametrize("age", [-30, 86400])
def test_auth_date_boundaries(telegram_init_data, settings, age):
    assert verify(telegram_init_data(auth_date=100000 - age), settings).username == "alice"


@pytest.mark.parametrize("date", [None, "", "bad", "100000.0", "-1", "0"])
def test_missing_or_malformed_signed_auth_date(telegram_init_data, settings, date):
    with pytest.raises(ValueError, match="Invalid Telegram profile"):
        verify(telegram_init_data(fields={"auth_date": date}), settings)


@pytest.mark.parametrize("data", ["", "a", "a=%FF", "a=" + "x" * 16384])
def test_malformed_query_and_size_rejected(settings, data):
    with pytest.raises(ValueError, match="Invalid Telegram profile"):
        verify(data, settings)


@pytest.mark.parametrize(
    "user",
    [
        [],
        "bad",
        {},
        {"id": True},
        {"id": 0},
        {"id": -1},
        {"id": "123"},
        {"id": 1.0},
        {"id": 1, "username": []},
    ],
)
def test_malformed_user_rejected(telegram_init_data, settings, user):
    with pytest.raises(ValueError, match="Invalid Telegram profile"):
        verify(telegram_init_data(auth_date=100000, user=user), settings)


@pytest.mark.parametrize(
    "mutation", ["hash", "token", "duplicate", "missing_date", "json", "signature"]
)
def test_invalid_data_rejected(telegram_init_data, settings, mutation):
    data = telegram_init_data(auth_date=100000, fields={"signature": "signed"})
    values = dict(parse_qsl(data))
    if mutation == "hash":
        values["hash"] = "0" * 64
    elif mutation == "token":
        data = telegram_init_data(auth_date=100000, bot_token="wrong")
    elif mutation == "duplicate":
        data += "&user=%7B%7D"
    elif mutation == "missing_date":
        del values["auth_date"]
    elif mutation == "json":
        data = telegram_init_data(auth_date=100000, fields={"user": "{"})
    elif mutation == "signature":
        values["signature"] = "tampered"
    if mutation in {"hash", "missing_date", "signature"}:
        data = urlencode(values)
    with pytest.raises(ValueError, match="Invalid Telegram profile"):
        verify(data, settings)


@pytest.mark.parametrize(
    "photo,expected",
    [
        (None, None),
        ("https://t.me/i/userpic/320/photo.jpg", "https://t.me/i/userpic/320/photo.jpg"),
        ("http://t.me/photo", None),
        ("javascript:alert(1)", None),
        ("https://user:password@t.me/photo", None),
        ("https://api.telegram.org/file/botSECRET/photo", None),
        ("https://API.TELEGRAM.ORG./file/botSECRET/photo", None),
        ("https://t.me\\@api.telegram.org/photo", None),
        ("https:///photo", None),
    ],
)
def test_optional_safe_photo_and_no_real_name_fallback(
    telegram_init_data, settings, photo, expected
):
    user = {"id": 123456789, "first_name": "Private real name"}
    if photo is not None:
        user["photo_url"] = photo
    profile = verify(telegram_init_data(auth_date=100000, user=user), settings)
    assert profile.username is None
    assert profile.avatar_url == expected
    assert "123456789" not in json.dumps(
        {"username": profile.username, "avatar_url": profile.avatar_url}
    )
