"""Upload a generated hour file to MinIO under the frozen raw path convention:

    raw/usage_logs/date=YYYY-MM-DD/hour=HH/minute=MM/part-*.json.gz

Usage:
    python upload.py --hour 2026-07-14T09 --file ./data/part-2026071409-0000.json.gz
"""

import argparse
import os

import boto3
from botocore.client import Config

from generate import parse_interval_start


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.getenv("MINIO_ENDPOINT", "http://localhost:9000"),
        aws_access_key_id=os.environ["MINIO_ROOT_USER"],
        aws_secret_access_key=os.environ["MINIO_ROOT_PASSWORD"],
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


def raw_key(start, filename: str) -> str:
    return (f"raw/usage_logs/date={start.strftime('%Y-%m-%d')}/"
            f"hour={start.strftime('%H')}/minute={start.strftime('%M')}/{filename}")


def upload_file(path: str, start, bucket: str | None = None) -> str:
    bucket = bucket or os.getenv("MINIO_BUCKET", "telecom-lake")
    key = raw_key(start, os.path.basename(path))
    s3_client().upload_file(path, bucket, key)
    return f"s3://{bucket}/{key}"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--start", help="UTC interval start, e.g. 2026-07-14T09:20")
    p.add_argument("--hour", help=argparse.SUPPRESS)
    p.add_argument("--file", required=True, help="local .json.gz to upload")
    args = p.parse_args()

    start_arg = args.start or args.hour
    if not start_arg:
        p.error("--start is required")
    uri = upload_file(args.file, parse_interval_start(start_arg))
    print(f"uploaded -> {uri}")


if __name__ == "__main__":
    main()
