/* The Unix socket server of `tsc-ts --api --listen` on Linux and macOS (listen-posix.c). */
#ifndef TSC_TS_LISTEN_POSIX_H
#define TSC_TS_LISTEN_POSIX_H

#include <stddef.h>
#include <stdint.h>

/* The descriptor of a socket listening at the path in the UTF-8 `bytes`, which
 * it binds with mode 0600, replacing a socket file no server answers on; -1
 * after an error message on standard error. */
int32_t tsc_ts_listen(const uint8_t *bytes, size_t size);

/* The descriptor of the next client of this process's user on `listener`;
 * -2 when none connects within `timeout_ms` milliseconds (never, when it is
 * negative), or -1 after an error message on standard error. Clients of
 * other users are closed. */
int32_t tsc_ts_accept(int32_t listener, int32_t timeout_ms);

/* Closes a client's descriptor. */
void tsc_ts_close(int32_t fd);

/* Closes `listener` and removes the socket file at the path in `bytes` if it
 * is still the one tsc_ts_listen bound. */
void tsc_ts_unlisten(int32_t listener, const uint8_t *bytes, size_t size);

#endif
