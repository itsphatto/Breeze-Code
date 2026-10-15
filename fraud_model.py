"""
AI Fraud Detection Model - Transaction-Based Fraud Detection with Relationship Analysis
Version 1.0 (Hackathon MVP)

Implements the 10-factor weighted risk score:

    FRAUD_SCORE = sum(w_i * score_i)   for i in 1..10

Each factor score is in [0, 1]; weights sum to 1.0.

Usage:
    python fraud_model.py          # runs two demo scenarios
"""

from __future__ import annotations

import json
import math
import statistics
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Dict, List, Optional

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

DEFAULT_WEIGHTS: Dict[str, float] = {
    "relationship": 0.20,
    "geographic": 0.15,
    "amount_anomaly": 0.15,
    "temporal_pattern": 0.12,
    "receiver_risk": 0.10,
    "device_behavior": 0.08,
    "receiver_health": 0.10,
    "sender_profile": 0.07,
    "amount_round": 0.02,
    "currency_risk": 0.01,
}

HIGH_RISK_CATEGORIES = {"cryptocurrency", "money_transfer_services", "gambling", "adult_content"}
MEDIUM_RISK_CATEGORIES = {"digital_goods", "forex_trading"}

MAJOR_CURRENCY_PAIRS = {
    ("USD", "THB"), ("USD", "EUR"), ("USD", "GBP"), ("USD", "JPY"),
    ("THB", "USD"), ("THB", "SGD"), ("THB", "MYR"),
}

# (upper_bound_exclusive, risk_level, action, message) - checked in order
DECISION_BANDS = [
    (0.30, "LOW", "APPROVE", "Transaction approved - low fraud risk"),
    (0.50, "MEDIUM-LOW", "MONITOR", "Transaction approved - monitor for patterns"),
    (0.70, "MEDIUM-HIGH", "FLAG_FOR_REVIEW", "Transaction flagged - requires manual review"),
    (0.85, "HIGH", "CHALLENGE", "Requires additional verification (OTP, call, etc)"),
    (float("inf"), "CRITICAL", "BLOCK", "Transaction declined - fraud suspected"),
]


# --------------------------------------------------------------------------- #
# Data structures
# --------------------------------------------------------------------------- #

@dataclass
class Location:
    country: str
    city: str = ""
    lat: float = 0.0
    lon: float = 0.0


@dataclass
class Transaction:
    sender_id: str
    receiver_id: str
    amount: float
    timestamp: datetime
    sender_location: Location
    receiver_location: Location
    currency: str = "USD"
    receiver_currency: Optional[str] = None      # defaults to `currency`
    device_id: Optional[str] = None
    ip_location: Optional[Location] = None       # pre-geolocated IP address
    ip_address: Optional[str] = None
    # Optional direct inputs; when given they replace the haversine calculation.
    distance_km: Optional[float] = None          # sender <-> receiver distance
    ip_distance_km: Optional[float] = None       # IP location <-> sender's home location


@dataclass
class AccountProfile:
    """Profile data for a sender or receiver account."""
    account_id: str
    age_days: int = 0
    kyc_verified: bool = False
    verified_status: bool = False                # account_status == "verified"
    flagged_for_fraud: bool = False
    blacklisted: bool = False
    prior_fraud_reports: int = 0
    dispute_rate: float = 0.0
    account_type: str = "consumer"               # "merchant" | "consumer"
    category: str = ""                           # merchant category
    profile_location: Optional[Location] = None  # sender's home location
    known_devices: Dict[str, int] = field(default_factory=dict)  # device_id -> days since last seen
    # Receiver-side activity stats
    incoming_tx_last_hour: int = 0
    incoming_tx_last_24h: int = 0
    micro_tx_pattern: bool = False
    unique_senders_last_30d: int = 0
    # Sender-side activity stats
    tx_count_last_hour: int = 0


@dataclass
class RelationshipData:
    """Everything known about the A <-> B relationship."""
    prior_amounts: List[float] = field(default_factory=list)
    last_tx_time: Optional[datetime] = None
    linkedin_connection: bool = False
    social_media_connected: bool = False
    in_contact_list: bool = False

    @property
    def prior_transactions(self) -> int:
        return len(self.prior_amounts)


@dataclass
class FraudResult:
    fraud_score: float
    risk_level: str
    recommendation: str
    message: str
    factors: Dict[str, Dict[str, float]]

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def haversine_km(a: Location, b: Location) -> float:
    """Great-circle distance between two locations in kilometres."""
    r = 6371.0088
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp = p2 - p1
    dl = math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def trailing_zeros(amount: float) -> int:
    """Number of trailing zeros in the integer part of a whole-number amount."""
    if amount != int(amount) or amount == 0:
        return 0
    s = str(int(amount))
    return len(s) - len(s.rstrip("0"))


# --------------------------------------------------------------------------- #
# Factor scorers (w1 - w10). Each returns a value in [0, 1].
# --------------------------------------------------------------------------- #

def score_relationship(rel: RelationshipData) -> float:
    """w1 - Does A have an established relationship with B?"""
    if rel.prior_transactions > 10:
        return 0.05
    if rel.prior_transactions >= 5:
        return 0.10
    if rel.linkedin_connection:
        return 0.15
    if rel.social_media_connected:
        return 0.35
    if rel.in_contact_list:
        return 0.30
    return 0.90


def score_geographic(tx: Transaction) -> float:
    """w2 - Domestic vs. international distance bands."""
    if tx.sender_location.country == tx.receiver_location.country:
        return 0.20
    d = tx.distance_km if tx.distance_km is not None else haversine_km(
        tx.sender_location, tx.receiver_location)
    if d < 1_000:
        return 0.30
    if d <= 5_000:
        return 0.60
    return 0.85


def score_amount_anomaly(amount: float, rel: RelationshipData) -> float:
    """w3 - z-score of the amount vs. prior A->B transactions."""
    prior = rel.prior_amounts
    if len(prior) < 2:
        return 0.80
    mean = statistics.mean(prior)
    std = statistics.stdev(prior)
    if std == 0:  # all prior amounts identical: any deviation is extreme
        z = 0.0 if amount == mean else float("inf")
    else:
        z = (amount - mean) / std
    if z < 1.0:
        return 0.10
    if z < 2.0:
        return 0.40
    if z < 3.0:
        return 0.70
    return 0.95


def score_temporal(tx: Transaction, sender: AccountProfile, rel: RelationshipData) -> float:
    """w4 - Average of time-of-day, velocity and dormancy sub-scores."""
    # A: time of day
    h = tx.timestamp.hour
    if 0 <= h < 3:
        s_time = 0.85
    elif 3 <= h < 6:
        s_time = 0.60
    elif 6 <= h < 22:
        s_time = 0.10
    else:
        s_time = 0.40

    # B: velocity (spec leaves 0 prior tx unspecified -> treated as normal)
    n = sender.tx_count_last_hour
    if n > 5:
        s_vel = 0.85
    elif n >= 2:
        s_vel = 0.50
    else:
        s_vel = 0.10

    # C: relationship dormancy
    if rel.last_tx_time is None:
        s_dorm = 0.40
    else:
        days = (tx.timestamp - rel.last_tx_time).days
        if days < 7:
            s_dorm = 0.10
        elif days <= 180:
            s_dorm = 0.30
        else:
            s_dorm = 0.60

    return (s_time + s_vel + s_dorm) / 3


def score_receiver_risk(receiver: AccountProfile) -> float:
    """w5 - Receiver base risk plus merchant-category adjustment."""
    if receiver.blacklisted:
        base = 0.95
    elif receiver.age_days < 30:
        base = 0.60
    elif not receiver.kyc_verified:
        base = 0.70
    elif receiver.flagged_for_fraud:
        base = 0.80
    elif receiver.verified_status and receiver.age_days > 180:
        base = 0.15
    else:
        base = 0.40

    if receiver.category in HIGH_RISK_CATEGORIES:
        base += 0.25
    elif receiver.category in MEDIUM_RISK_CATEGORIES:
        base += 0.10
    return min(base, 1.0)


def score_device(tx: Transaction, sender: AccountProfile) -> float:
    """w6 - Average of device-novelty and IP-consistency sub-scores."""
    # A: device novelty
    if tx.device_id is None or tx.device_id not in sender.known_devices:
        s_dev = 0.50
    elif sender.known_devices[tx.device_id] > 90:
        s_dev = 0.40
    else:
        s_dev = 0.10

    # B: IP geolocation vs. profile location (neutral-low if unavailable)
    if tx.ip_distance_km is not None:
        d: Optional[float] = tx.ip_distance_km
    elif tx.ip_location is not None and sender.profile_location is not None:
        d = haversine_km(tx.ip_location, sender.profile_location)
    else:
        d = None

    if d is None:
        s_ip = 0.10
    else:
        if d < 100:
            s_ip = 0.10
        elif d < 500:
            s_ip = 0.30
        elif d < 5_000:
            s_ip = 0.60
        else:
            s_ip = 0.85

    return (s_dev + s_ip) / 2


def score_receiver_health(receiver: AccountProfile) -> float:
    """w7 - Money-laundering / mule-account indicators on the receiver."""
    if receiver.incoming_tx_last_hour > 10:
        return 0.90
    if receiver.incoming_tx_last_24h > 50:
        return 0.75
    if receiver.micro_tx_pattern:
        return 0.70
    if receiver.unique_senders_last_30d > 100:
        return 0.65
    if receiver.dispute_rate > 0.05:
        return 0.60
    return 0.10


def score_sender_profile(sender: AccountProfile) -> float:
    """w8 - Sender account integrity and history."""
    if sender.flagged_for_fraud:
        return 0.95
    if sender.age_days < 30:
        return 0.60
    if not sender.kyc_verified:
        return 0.65
    if sender.prior_fraud_reports > 0:
        return 0.85
    if sender.dispute_rate > 0.05:
        return 0.60
    if sender.verified_status and sender.age_days > 180:
        return 0.10
    return 0.40


def score_amount_round(amount: float, receiver: AccountProfile) -> float:
    """w9 - Suspiciously round amounts (context-dependent on receiver type)."""
    tz = trailing_zeros(amount)
    if receiver.account_type == "merchant":
        return 0.15 if tz >= 2 else 0.05
    if receiver.account_type == "consumer":
        if tz >= 3:
            return 0.50
        if tz == 2:
            return 0.30
        return 0.05
    return 0.10


def score_currency(tx: Transaction, pair_volatility: Optional[Dict[tuple, float]] = None) -> float:
    """w10 - Currency pair risk."""
    if tx.sender_location.country == tx.receiver_location.country:
        return 0.05
    sc = tx.currency
    rc = tx.receiver_currency or tx.currency
    # Same currency on both sides (no FX conversion) is treated like a major pair.
    if sc == rc or (sc, rc) in MAJOR_CURRENCY_PAIRS:
        return 0.20
    vol = (pair_volatility or {}).get((sc, rc), 0.0)
    return 0.70 if vol > 0.02 else 0.50


# --------------------------------------------------------------------------- #
# Main model
# --------------------------------------------------------------------------- #

class FraudDetector:
    def __init__(self, weights: Optional[Dict[str, float]] = None,
                 pair_volatility: Optional[Dict[tuple, float]] = None):
        self.weights = dict(weights or DEFAULT_WEIGHTS)
        self.pair_volatility = pair_volatility or {}
        self._validate_weights()

    def _validate_weights(self) -> None:
        missing = set(DEFAULT_WEIGHTS) - set(self.weights)
        if missing:
            raise ValueError(f"Missing weights: {sorted(missing)}")
        if any(not 0.0 <= w <= 1.0 for w in self.weights.values()):
            raise ValueError("Each weight must be in [0, 1]")
        total = sum(self.weights.values())
        if not math.isclose(total, 1.0, abs_tol=1e-9):
            raise ValueError(f"Weights must sum to 1.0 (got {total:.6f})")

    @staticmethod
    def classify(score: float):
        for upper, level, action, message in DECISION_BANDS:
            if score < upper:
                return level, action, message
        raise AssertionError("unreachable")

    def evaluate(self, tx: Transaction, sender: AccountProfile,
                 receiver: AccountProfile, rel: RelationshipData) -> FraudResult:
        raw = {
            "relationship": score_relationship(rel),
            "geographic": score_geographic(tx),
            "amount_anomaly": score_amount_anomaly(tx.amount, rel),
            "temporal_pattern": score_temporal(tx, sender, rel),
            "receiver_risk": score_receiver_risk(receiver),
            "device_behavior": score_device(tx, sender),
            "receiver_health": score_receiver_health(receiver),
            "sender_profile": score_sender_profile(sender),
            "amount_round": score_amount_round(tx.amount, receiver),
            "currency_risk": score_currency(tx, self.pair_volatility),
        }
        factors = {
            name: {
                "score": round(s, 4),
                "weight": self.weights[name],
                "contribution": round(s * self.weights[name], 4),
            }
            for name, s in raw.items()
        }
        fraud_score = round(sum(f["contribution"] for f in factors.values()), 4)
        level, action, message = self.classify(fraud_score)
        return FraudResult(fraud_score, level, action, message, factors)


# --------------------------------------------------------------------------- #
# Demo
# --------------------------------------------------------------------------- #

def _demo() -> None:
    bangkok = Location("TH", "Bangkok", 13.7563, 100.5018)
    new_york = Location("US", "New York", 40.7128, -74.0060)
    detector = FraudDetector()

    # Example 1: unknown international recipient, large amount, 2 AM, new device
    tx1 = Transaction(
        sender_id="A", receiver_id="B", amount=50_000,
        timestamp=datetime(2026, 10, 15, 2, 0),
        sender_location=bangkok, receiver_location=new_york,
        currency="USD", device_id="new-device", ip_location=bangkok,
    )
    sender1 = AccountProfile("A", age_days=5 * 365, kyc_verified=True, verified_status=True,
                             profile_location=bangkok, known_devices={"old-device": 3})
    receiver1 = AccountProfile("B", age_days=2, kyc_verified=False, account_type="consumer")
    rel1 = RelationshipData()

    # Example 2: regular domestic supplier payment
    tx2 = Transaction(
        sender_id="A", receiver_id="S", amount=15_000,
        timestamp=datetime(2026, 10, 15, 10, 0),
        sender_location=bangkok, receiver_location=bangkok,
        currency="THB", device_id="regular", ip_location=bangkok,
    )
    sender2 = AccountProfile("A", age_days=4 * 365, kyc_verified=True, verified_status=True,
                             profile_location=bangkok, known_devices={"regular": 1})
    receiver2 = AccountProfile("S", age_days=3 * 365, kyc_verified=True, verified_status=True,
                               account_type="merchant")
    rel2 = RelationshipData(
        prior_amounts=[14_000, 15_500, 14_800, 15_200, 14_900, 15_100, 15_300,
                       14_700, 15_000, 15_400, 14_600, 15_050],
        last_tx_time=datetime(2026, 10, 12, 10, 0),
    )

    for title, args in [
        ("Example 1: Unknown international recipient", (tx1, sender1, receiver1, rel1)),
        ("Example 2: Regular domestic transaction", (tx2, sender2, receiver2, rel2)),
    ]:
        result = detector.evaluate(*args)
        print(f"\n=== {title} ===")
        print(json.dumps({
            "fraud_score": result.fraud_score,
            "risk_level": result.risk_level,
            "recommendation": result.recommendation,
        }, indent=2))
        print(f"{'factor':<18}{'score':>7}{'weight':>8}{'contrib':>9}")
        for name, f in result.factors.items():
            print(f"{name:<18}{f['score']:>7.2f}{f['weight']:>8.2f}{f['contribution']:>9.4f}")


if __name__ == "__main__":
    _demo()