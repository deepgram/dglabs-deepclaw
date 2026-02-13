"""Tests for MMS media extraction and multimodal content building."""

import base64
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.datastructures import FormData, ImmutableMultiDict

from app.services.mms_media import build_message_content


def _form(**kwargs) -> FormData:
    """Build a FormData from keyword args."""
    return FormData(ImmutableMultiDict(kwargs))


@pytest.mark.asyncio
async def test_text_only_returns_string():
    form = _form(Body="hello", NumMedia="0")
    result = await build_message_content(form)
    assert result == "hello"


@pytest.mark.asyncio
async def test_no_nummedia_returns_body():
    form = _form(Body="just text")
    result = await build_message_content(form)
    assert result == "just text"


@pytest.mark.asyncio
async def test_image_mms_returns_multimodal():
    fake_image = b"\xff\xd8\xff\xe0fake-jpeg"
    mock_resp = MagicMock()
    mock_resp.content = fake_image
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    form = _form(
        Body="look at this",
        NumMedia="1",
        MediaUrl0="https://api.twilio.com/media/img.jpg",
        MediaContentType0="image/jpeg",
    )

    with patch("app.services.mms_media.httpx.AsyncClient", return_value=mock_client):
        result = await build_message_content(form)

    assert isinstance(result, list)
    assert len(result) == 2
    assert result[0] == {"type": "text", "text": "look at this"}
    assert result[1]["type"] == "image_url"
    expected_b64 = base64.b64encode(fake_image).decode("ascii")
    assert result[1]["image_url"]["url"] == f"data:image/jpeg;base64,{expected_b64}"


@pytest.mark.asyncio
async def test_image_only_no_body():
    fake_image = b"\x89PNG"
    mock_resp = MagicMock()
    mock_resp.content = fake_image
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.get.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    form = _form(
        Body="",
        NumMedia="1",
        MediaUrl0="https://api.twilio.com/media/img.png",
        MediaContentType0="image/png",
    )

    with patch("app.services.mms_media.httpx.AsyncClient", return_value=mock_client):
        result = await build_message_content(form)

    assert isinstance(result, list)
    assert len(result) == 1
    assert result[0]["type"] == "image_url"


@pytest.mark.asyncio
async def test_unsupported_media_type():
    form = _form(
        Body="",
        NumMedia="1",
        MediaUrl0="https://api.twilio.com/media/video.mp4",
        MediaContentType0="video/mp4",
    )

    # No HTTP mock needed since unsupported types don't trigger download
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch("app.services.mms_media.httpx.AsyncClient", return_value=mock_client):
        result = await build_message_content(form)

    assert isinstance(result, list)
    assert result[0] == {"type": "text", "text": "[Unsupported media type: video/mp4]"}


@pytest.mark.asyncio
async def test_image_download_failure_graceful():
    mock_client = AsyncMock()
    mock_client.get.side_effect = Exception("connection timeout")
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    form = _form(
        Body="",
        NumMedia="1",
        MediaUrl0="https://api.twilio.com/media/img.jpg",
        MediaContentType0="image/jpeg",
    )

    with patch("app.services.mms_media.httpx.AsyncClient", return_value=mock_client):
        result = await build_message_content(form)

    assert isinstance(result, list)
    assert result[0] == {"type": "text", "text": "[Failed to load image: image/jpeg]"}
