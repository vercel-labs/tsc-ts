/* Checks how tsc_ts_listen treats a socket file that exists: it refuses one a
 * server listens on without waiting, also when the server's queue of pending
 * clients is full (Linux, where a connect to a full queue would wait), and
 * replaces one no server listens on. tests/api-listen.test.mjs builds it with
 * clang and runs it. Exits 0 when all hold. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "listen-posix.h"

static int fail(const char *message) {
  fprintf(stderr, "listen-posix.test: %s\n", message);
  return 1;
}

int main(void) {
  char directory[] = "/tmp/tsc-ts-listen-test-XXXXXX";
  if (mkdtemp(directory) == NULL) return fail("cannot create a directory");
  struct sockaddr_un address;
  memset(&address, 0, sizeof address);
  address.sun_family = AF_UNIX;
  snprintf(address.sun_path, sizeof address.sun_path, "%s/s", directory);
  const uint8_t *path = (const uint8_t *)address.sun_path;
  size_t size = strlen(address.sun_path);
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0 || bind(server, (struct sockaddr *)&address, sizeof address) != 0 || listen(server, 0) != 0)
    return fail("cannot create the listening socket");
  int clients[64];
  int count = 0;
#ifdef __linux__
  /* Clients the server never accepts, until the queue is full. */
  for (; count < 64; count++) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return fail("cannot create a client");
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    if (connect(fd, (struct sockaddr *)&address, sizeof address) != 0) {
      int error = errno;
      close(fd);
      if (error != EAGAIN && error != EWOULDBLOCK) return fail("a client of the full queue failed");
      break;
    }
    clients[count] = fd;
  }
  if (count == 64) return fail("the queue did not fill");
#endif
  /* A probe that waited would end here. */
  alarm(10);
  if (tsc_ts_listen(path, size) != -1) return fail("a socket a server listens on was replaced");
  for (int i = 0; i < count; i++) close(clients[i]);
  close(server);
  int listener = tsc_ts_listen(path, size);
  if (listener < 0) return fail("a socket file no server listens on was not replaced");
  tsc_ts_unlink(path, size);
  tsc_ts_close(listener);
  if (access(address.sun_path, F_OK) == 0) return fail("the socket file was not removed");
  rmdir(directory);
  printf("tsc_ts_listen refuses a socket a server listens on and replaces a socket file left behind\n");
  return 0;
}
