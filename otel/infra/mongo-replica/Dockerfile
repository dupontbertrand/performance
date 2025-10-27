# syntax=docker/dockerfile:1

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV REPLSET_NAME=rs0

RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    lsb-release \
    wget \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
    gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor && \
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
    tee /etc/apt/sources.list.d/mongodb-org-7.0.list && \
    apt-get update && \
    apt-get install -y mongodb-org && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /data/mongo-replica

COPY start-mongo-replica-docker.sh /app/
RUN chmod +x /app/start-mongo-replica-docker.sh

EXPOSE 27017 27018 27019

ENTRYPOINT ["/app/start-mongo-replica-docker.sh"]
