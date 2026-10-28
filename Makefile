# ==============================================================================
# Makefile: Production-Grade Supabase Architecture
# ==============================================================================

.PHONY: all install start stop reset test test-db bench lint types clean help

all: help

install:
	npm install

start:
	./bin/supa-forge start

stop:
	./bin/supa-forge stop

reset:
	./bin/supa-forge reset

test:
	./bin/supa-forge test:unit

test-db:
	./bin/supa-forge test:db

bench:
	./bin/supa-forge bench

lint:
	./bin/supa-forge lint

types:
	supabase gen types typescript --local > src/types/database.types.ts

clean:
	rm -rf dist node_modules coverage benchmarks/results/*.raw.json

help:
	@echo "Available commands:"
	@echo "  make install   Install dependencies"
	@echo "  make start     Spin up local Supabase stack with Supavisor"
	@echo "  make stop      Stop local Supabase stack"
	@echo "  make reset     Apply migrations and deterministic seed"
	@echo "  make test      Run unit test suite"
	@echo "  make test-db   Run pgTAP database tests"
	@echo "  make bench     Execute benchmark runner and update report"
	@echo "  make lint      Run schema linters"
	@echo "  make types     Regenerate TypeScript database types"
