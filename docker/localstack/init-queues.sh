#!/bin/sh
set -eu

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,MessageRetentionPeriod=1209600
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes file:///etc/localstack/inbound-attributes.json
awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false
