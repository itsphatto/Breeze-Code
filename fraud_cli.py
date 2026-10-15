"""
Interactive input for the fraud detection model.

Asks for every variable the model uses (A-B distance, A-B relation, amounts,
account profiles, device, ...) and prints the fraud score with a breakdown.

    python fraud_cli.py

Press Enter at any prompt to accept the value shown in [brackets].
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable, List, Optional

from fraud_model import (
    AccountProfile,
    FraudDetector,
    Location,
    RelationshipData,
    Transaction,
)

# --------------------------------------------------------------------------- #
# Prompt helpers (Enter = default, invalid input re-prompts)
# --------------------------------------------------------------------------- #

def _ask(prompt: str, default: str, parse: Callable[[str], object]):
    while True:
        raw = input(f"  {prompt} [{default}]: ").strip()
        if raw == "":
            raw = default
        try:
            return parse(raw)
        except ValueError as e:
            print(f"    -> invalid: {e}")


def ask_str(prompt: str, default: str = "") -> str:
    return _ask(prompt, default, lambda s: s)


def ask_float(prompt: str, default: float, minimum: float = 0.0) -> float:
    def parse(s: str) -> float:
        v = float(s.replace(",", ""))
        if v < minimum:
            raise ValueError(f"must be >= {minimum}")
        return v
    return _ask(prompt, str(default), parse)


def ask_int(prompt: str, default: int, minimum: int = 0) -> int:
    def parse(s: str) -> int:
        v = int(s.replace(",", ""))
        if v < minimum:
            raise ValueError(f"must be >= {minimum}")
        return v
    return _ask(prompt, str(default), parse)


def ask_bool(prompt: str, default: bool = False) -> bool:
    def parse(s: str) -> bool:
        s = s.lower()
        if s in ("y", "yes", "true", "1"):
            return True
        if s in ("n", "no", "false", "0"):
            return False
        raise ValueError("answer y or n")
    return _ask(prompt + " (y/n)", "y" if default else "n", parse)


def ask_choice(prompt: str, choices: List[str], default: str) -> str:
    def parse(s: str) -> str:
        s = s.lower()
        if s not in choices:
            raise ValueError("choose one of: " + ", ".join(choices))
        return s
    return _ask(f"{prompt} ({'/'.join(choices)})", default, parse)


def ask_amount_list(prompt: str) -> List[float]:
    def parse(s: str) -> List[float]:
        if s.lower() in ("", "none", "-"):
            return []
        return [float(x.replace(",", "")) for x in s.split(",") if x.strip()]
    return _ask(prompt, "none", parse)


def ask_time(prompt: str, default: str) -> tuple:
    def parse(s: str):
        h, m = s.split(":")
        h, m = int(h), int(m)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError("use HH:MM, 24-hour")
        return h, m
    return _ask(prompt, default, parse)


def section(title: str) -> None:
    print(f"\n--- {title} ---")


# --------------------------------------------------------------------------- #
# Collect inputs
# --------------------------------------------------------------------------- #

def collect_inputs():
    now = datetime.now()

    # ---- Transaction -------------------------------------------------------
    section("Transaction (A -> B)")
    amount = ask_float("Amount", 1000.0)
    currency = ask_str("Sender currency", "USD").upper()
    receiver_currency = ask_str("Receiver currency", currency).upper()
    hh, mm = ask_time("Time of transaction (HH:MM, 24h)", now.strftime("%H:%M"))
    timestamp = now.replace(hour=hh, minute=mm, second=0, microsecond=0)

    # ---- A-B distance ------------------------------------------------------
    section("A-B distance")
    sender_country = ask_str("Sender (A) country code", "TH").upper()
    receiver_country = ask_str("Receiver (B) country code", sender_country).upper()
    distance_km: Optional[float] = None
    if sender_country != receiver_country:
        distance_km = ask_float("Distance between A and B (km)", 1500.0)
    else:
        print("  (domestic transaction - distance not needed)")

    # ---- A-B relation ------------------------------------------------------
    section("A-B relation")
    prior_amounts = ask_amount_list(
        "Amounts of prior A->B transactions (comma-separated, or none)")
    last_tx_time = None
    if prior_amounts:
        days_ago = ask_int("Days since last A->B transaction", 3)
        last_tx_time = timestamp - timedelta(days=days_ago)
    linkedin = ask_bool("A and B connected on LinkedIn / business registry", False)
    social = ask_bool("A and B connected on social media (Facebook, Instagram...)", False)
    contact = ask_bool("B is in A's contact list", False)

    # ---- Sender A ----------------------------------------------------------
    section("Sender A profile")
    s_age = ask_int("Account age (days)", 400)
    s_kyc = ask_bool("KYC verified", True)
    s_verified = ask_bool("Account status 'verified'", True)
    s_flagged = ask_bool("Flagged for fraud", False)
    s_reports = ask_int("Prior fraud reports", 0)
    s_dispute = ask_float("Dispute rate (0-1, e.g. 0.05 = 5%)", 0.0)
    s_velocity = ask_int("Transactions A made in the last hour", 1)

    # ---- Device / IP -------------------------------------------------------
    section("Device and IP")
    dev = ask_str("Device: 'new' or days since last used", "5").lower()
    if dev == "new":
        device_id, known_devices = "device-1", {}
    else:
        try:
            known_devices = {"device-1": max(0, int(dev))}
        except ValueError:
            print("    -> not a number, treating device as new")
            known_devices = {}
        device_id = "device-1"
    ip_distance = ask_float("Distance of IP location from A's home location (km)", 0.0)

    # ---- Receiver B --------------------------------------------------------
    section("Receiver B profile")
    r_type = ask_choice("Receiver type", ["consumer", "merchant"], "consumer")
    r_category = ask_str(
        "Merchant category (cryptocurrency, money_transfer_services, gambling, "
        "adult_content, digital_goods, forex_trading, or blank)", "").lower()
    r_age = ask_int("Account age (days)", 400)
    r_kyc = ask_bool("KYC verified", True)
    r_verified = ask_bool("Account status 'verified'", True)
    r_flagged = ask_bool("Flagged for fraud", False)
    r_black = ask_bool("Blacklisted", False)
    r_dispute = ask_float("Dispute rate (0-1)", 0.0)
    r_in_hour = ask_int("Incoming transactions to B in the last hour", 0)
    r_in_24h = ask_int("Incoming transactions to B in the last 24 hours", 0)
    r_micro = ask_bool("B receives many micro-transactions (<100 USD)", False)
    r_senders = ask_int("Unique senders to B in the last 30 days", 5)

    # ---- Build objects -----------------------------------------------------
    tx = Transaction(
        sender_id="A", receiver_id="B", amount=amount, timestamp=timestamp,
        sender_location=Location(sender_country),
        receiver_location=Location(receiver_country),
        currency=currency, receiver_currency=receiver_currency,
        device_id=device_id, distance_km=distance_km, ip_distance_km=ip_distance,
    )
    sender = AccountProfile(
        "A", age_days=s_age, kyc_verified=s_kyc, verified_status=s_verified,
        flagged_for_fraud=s_flagged, prior_fraud_reports=s_reports,
        dispute_rate=s_dispute, known_devices=known_devices,
        tx_count_last_hour=s_velocity,
    )
    receiver = AccountProfile(
        "B", age_days=r_age, kyc_verified=r_kyc, verified_status=r_verified,
        flagged_for_fraud=r_flagged, blacklisted=r_black, dispute_rate=r_dispute,
        account_type=r_type, category=r_category,
        incoming_tx_last_hour=r_in_hour, incoming_tx_last_24h=r_in_24h,
        micro_tx_pattern=r_micro, unique_senders_last_30d=r_senders,
    )
    rel = RelationshipData(
        prior_amounts=prior_amounts, last_tx_time=last_tx_time,
        linkedin_connection=linkedin, social_media_connected=social,
        in_contact_list=contact,
    )
    return tx, sender, receiver, rel


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #

def print_result(result) -> None:
    print("\n" + "=" * 52)
    print(f" FRAUD SCORE : {result.fraud_score:.4f}")
    print(f" RISK LEVEL  : {result.risk_level}")
    print(f" ACTION      : {result.recommendation}")
    print(f" {result.message}")
    print("=" * 52)
    print(f" {'factor':<18}{'score':>7}{'weight':>8}{'contrib':>9}")
    for name, f in sorted(result.factors.items(),
                          key=lambda kv: kv[1]["contribution"], reverse=True):
        print(f" {name:<18}{f['score']:>7.2f}{f['weight']:>8.2f}{f['contribution']:>9.4f}")


def main() -> None:
    detector = FraudDetector()
    print("Fraud detection input. Press Enter to accept the [default] value.")
    while True:
        try:
            result = detector.evaluate(*collect_inputs())
        except (EOFError, KeyboardInterrupt):
            print("\nCancelled.")
            return
        print_result(result)
        try:
            if not ask_bool("\nCheck another transaction", False):
                return
        except (EOFError, KeyboardInterrupt):
            return


if __name__ == "__main__":
    main()