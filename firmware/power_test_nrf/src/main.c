/*
 * Bench test 2 on the XIAO nRF52840 Sense. This version has the states that need no card or radio:
 * S1 and S2 (sleep, with a timer wake) and S3 (record and discard). Plan and wiring:
 * docs/plans/bench-test-2.md.
 *
 * Commands over USB (the mode is saved, and the board restarts in it):
 *   1  S1: sleep, board alone
 *   2  S2: sleep, with the microphone and card attached (the same firmware state as S1)
 *   3  S3: record and discard
 *   l  level meter: peak and RMS for 10 s (S3 only)
 *   i  info
 *
 * The nRF52840 has no audio clock, so I2S can't run at exactly 32 kHz, and it has no 32-bit I2S
 * frame. The driver picks the nearest rate: about 31.7 kHz, with 24-bit slots.
 */

#include <math.h>
#include <stdlib.h>
#include <zephyr/console/console.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/fs/nvs.h>
#include <zephyr/kernel.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/reboot.h>

#define SAMPLE_RATE 32000 /* requested; see above */
#define BLOCK_SAMPLES 512
#define BLOCK_COUNT 4
#define SAMPLE_SHIFT 14 /* the gain as in the ESP32 sketch; check it against the level meter */
#define HIGHPASS_HZ 200.0f
#define SETTLE_BLOCKS 16 /* discard the mic's first ~0.25 s after start-up */

enum mode { MODE_S1 = 1, MODE_S2 = 2, MODE_S3 = 3 };

static const struct device *const i2s_dev = DEVICE_DT_GET(DT_NODELABEL(i2s0));
static const struct device *const gpio0 = DEVICE_DT_GET(DT_NODELABEL(gpio0));
static const struct device *const gpio1 = DEVICE_DT_GET(DT_NODELABEL(gpio1));
K_MEM_SLAB_DEFINE_STATIC(mic_slab, BLOCK_SAMPLES * sizeof(int32_t), BLOCK_COUNT, 4);

#define MARK_REC_PIN 4 /* D4, P0.04 */
#define MARK_UP_PIN 5  /* D5, P0.05 */
#define MARK_SD_PIN 12 /* D7, P1.12 */

static struct nvs_fs nvs;
#define NVS_ID_MODE 1

static enum mode mode = MODE_S3;
static atomic_t meter_blocks;
static uint32_t blocks_read, read_errors;

/* A 2nd-order Butterworth high-pass (RBJ biquad, transposed direct form II), as in the ESP32 sketch. */
static float b0, b1, b2, a1, a2, z1, z2;

static void highpass_init(float hz, float rate)
{
	float w = 2 * 3.14159265f * hz / rate, c = cosf(w), alpha = sinf(w) / (2 * 0.70710678f);
	float a0 = 1 + alpha;

	b0 = (1 + c) / 2 / a0;
	b1 = -(1 + c) / a0;
	b2 = b0;
	a1 = -2 * c / a0;
	a2 = (1 - alpha) / a0;
}

static inline int16_t to_pcm16(int32_t raw)
{
	float x = (float)raw / (1 << SAMPLE_SHIFT);
	float y = b0 * x + z1;

	z1 = b1 * x - a1 * y + z2;
	z2 = b2 * x - a2 * y;
	return y > 32767 ? 32767 : y < -32768 ? -32768 : (int16_t)lrintf(y);
}

static int mode_load(void)
{
	const struct flash_area *fa;
	int rc = flash_area_open(FIXED_PARTITION_ID(storage_partition), &fa);

	if (rc) {
		return rc;
	}
	nvs.flash_device = fa->fa_dev;
	nvs.offset = fa->fa_off;
	nvs.sector_size = 4096;
	nvs.sector_count = 2;
	rc = nvs_mount(&nvs);
	if (rc) {
		return rc;
	}
	uint8_t saved;

	if (nvs_read(&nvs, NVS_ID_MODE, &saved, 1) == 1 && saved >= MODE_S1 && saved <= MODE_S3) {
		mode = saved;
	}
	return 0;
}

static void commands(void *, void *, void *)
{
	console_init();
	while (1) {
		uint8_t ch = console_getchar();

		if (ch >= '1' && ch <= '3') {
			uint8_t next = ch - '0';

			nvs_write(&nvs, NVS_ID_MODE, &next, 1);
			printk("mode S%u saved; restarting\n", next);
			k_msleep(100);
			sys_reboot(SYS_REBOOT_COLD);
		} else if (ch == 'l') {
			if (mode == MODE_S3) {
				atomic_set(&meter_blocks, 620); /* 10 s */
			} else {
				printk("the level meter needs S3 (command 3)\n");
			}
		} else if (ch == 'i') {
			printk("mode S%u, %u blocks read, %u read errors\n", mode, blocks_read, read_errors);
		}
	}
}
K_THREAD_DEFINE(commands_thread, 1024, commands, NULL, NULL, NULL, 7, 0, 0);

static int mic_start(void)
{
	struct i2s_config cfg = {
		.word_size = 24,
		.channels = 1,
		.format = I2S_FMT_DATA_FORMAT_I2S,
		.options = I2S_OPT_BIT_CLK_MASTER | I2S_OPT_FRAME_CLK_MASTER,
		.frame_clk_freq = SAMPLE_RATE,
		.mem_slab = &mic_slab,
		.block_size = BLOCK_SAMPLES * sizeof(int32_t),
		.timeout = 1000,
	};
	int rc = i2s_configure(i2s_dev, I2S_DIR_RX, &cfg);

	return rc ? rc : i2s_trigger(i2s_dev, I2S_DIR_RX, I2S_TRIGGER_START);
}

static void level_report(const int16_t *pcm, size_t n)
{
	static uint32_t peak, block;
	static double sum_sq;

	for (size_t k = 0; k < n; k++) {
		uint32_t a = abs(pcm[k]);

		peak = a > peak ? a : peak;
		sum_sq += (double)pcm[k] * pcm[k];
	}
	if (++block == 15) { /* print every 0.25 s */
		float rms = 20 * log10(sqrt(sum_sq / (block * n)) / 32768.0 + 1e-9);

		printk("rms %6.1f dBFS  peak %5u%s\n", (double)rms, peak, peak >= 32767 ? " CLIPPED" : "");
		peak = block = 0;
		sum_sq = 0;
	}
}

static void record(void)
{
	static int16_t pcm[BLOCK_SAMPLES];
	int rc = mic_start();

	if (rc) {
		printk("! mic (I2S) failed to start: %d\n", rc);
		return;
	}
	gpio_pin_set(gpio0, MARK_REC_PIN, 1);
	for (uint32_t skip = SETTLE_BLOCKS;;) {
		void *block;
		size_t size;

		if (i2s_read(i2s_dev, &block, &size)) {
			read_errors++;
			i2s_trigger(i2s_dev, I2S_DIR_RX, I2S_TRIGGER_DROP);
			i2s_trigger(i2s_dev, I2S_DIR_RX, I2S_TRIGGER_START);
			continue;
		}
		const int32_t *raw = block;
		size_t n = size / sizeof(int32_t);

		for (size_t k = 0; k < n; k++) {
			pcm[k] = to_pcm16(raw[k]);
		}
		k_mem_slab_free(&mic_slab, block);
		if (skip) {
			skip--;
			continue;
		}
		blocks_read++;
		if (atomic_get(&meter_blocks) > 0) {
			atomic_dec(&meter_blocks);
			level_report(pcm, n);
		}
	}
}

int main(void)
{
	gpio_pin_configure(gpio0, MARK_REC_PIN, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure(gpio0, MARK_UP_PIN, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure(gpio1, MARK_SD_PIN, GPIO_OUTPUT_INACTIVE);
	if (mode_load()) {
		printk("! saved mode unavailable; using S3\n");
	}
	highpass_init(HIGHPASS_HZ, SAMPLE_RATE);
	printk("birdTracker bench test 2, nRF52840, mode S%u\n", mode);
	if (mode == MODE_S3) {
		record();
	}
	return 0; /* the kernel idles: the timer wakes the chip, and nothing else runs */
}
