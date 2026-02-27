from __future__ import annotations

import json
from urllib.parse import urlparse

from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AttestationConveyancePreference,
    AuthenticationCredential,
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    RegistrationCredential,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from .config import settings


RP_NAME = "Codex Remote"


def _json_dict(value: object) -> dict:
    if isinstance(value, str):
        return json.loads(value)
    return json.loads(json.dumps(value, default=str))


def is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return False

    expected = settings.passkey_origin.strip()
    if expected:
        return origin == expected

    origins = settings.cors_origins
    if "*" in origins:
        return True
    return origin in origins


def get_rp_id(origin: str | None) -> str:
    if settings.passkey_rp_id:
        return settings.passkey_rp_id
    base = settings.passkey_origin or origin or ""
    parsed = urlparse(base)
    if not parsed.hostname:
        raise ValueError("PASSKEY_ORIGIN or PASSKEY_RP_ID is required for passkey mode")
    return parsed.hostname


def extract_client_data_challenge(credential_payload: dict) -> str | None:
    try:
        response = credential_payload.get("response") or {}
        encoded = response.get("clientDataJSON")
        if not isinstance(encoded, str):
            return None
        decoded = base64url_to_bytes(encoded)
        parsed = json.loads(decoded.decode("utf-8"))
        challenge = parsed.get("challenge")
        return challenge if isinstance(challenge, str) else None
    except Exception:
        return None


def make_registration_options(
    user_id: str,
    user_name: str,
    user_display_name: str,
    exclude_credentials: list[tuple[str, list[str] | None]],
    origin: str,
) -> dict:
    rp_id = get_rp_id(origin)

    exclude = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(credential_id), transports=transports)
        for credential_id, transports in exclude_credentials
    ]

    options = generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_id=user_id.encode("utf-8"),
        user_name=user_name,
        user_display_name=user_display_name,
        timeout=settings.challenge_ttl_sec * 1000,
        attestation=AttestationConveyancePreference.NONE,
        exclude_credentials=exclude,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
    )
    return _json_dict(options_to_json(options))


def verify_registration(
    credential_payload: dict,
    expected_challenge: str,
    origin: str,
) -> dict:
    rp_id = get_rp_id(origin)

    verified = verify_registration_response(
        credential=RegistrationCredential.parse_raw(json.dumps(credential_payload)),
        expected_challenge=expected_challenge,
        expected_origin=origin,
        expected_rp_id=rp_id,
        require_user_verification=True,
    )

    return {
        "credential_id": bytes_to_base64url(verified.credential_id),
        "credential_public_key": bytes_to_base64url(verified.credential_public_key),
        "sign_count": int(verified.sign_count),
        "credential_device_type": str(verified.credential_device_type),
        "credential_backed_up": bool(verified.credential_backed_up),
    }


def make_authentication_options(
    allow_credentials: list[tuple[str, list[str] | None]],
    origin: str,
) -> dict:
    rp_id = get_rp_id(origin)
    allow = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(credential_id), transports=transports)
        for credential_id, transports in allow_credentials
    ]

    options = generate_authentication_options(
        rp_id=rp_id,
        timeout=settings.challenge_ttl_sec * 1000,
        allow_credentials=allow,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    return _json_dict(options_to_json(options))


def verify_authentication(
    credential_payload: dict,
    expected_challenge: str,
    origin: str,
    credential_id: str,
    credential_public_key_b64: str,
    credential_sign_count: int,
) -> dict:
    rp_id = get_rp_id(origin)

    verified = verify_authentication_response(
        credential=AuthenticationCredential.parse_raw(json.dumps(credential_payload)),
        expected_challenge=expected_challenge,
        expected_origin=origin,
        expected_rp_id=rp_id,
        credential_id=base64url_to_bytes(credential_id),
        credential_public_key=base64url_to_bytes(credential_public_key_b64),
        credential_current_sign_count=credential_sign_count,
        require_user_verification=True,
    )

    return {"new_sign_count": int(verified.new_sign_count)}
