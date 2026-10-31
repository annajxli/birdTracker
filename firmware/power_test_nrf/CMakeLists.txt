# Bench test 2 firmware for the XIAO nRF52840 Sense. See docs/plans/bench-test-2.md.
cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(power_test_nrf)
target_sources(app PRIVATE src/main.c)
