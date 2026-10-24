/* The Unix socket server of `tsc-ts --api --listen` on Linux and macOS: the
 * server binds the socket path it is given and accepts one client at a time,
 * handing each connection to the API server as a descriptor, which it reads
 * and writes as it does standard input and output. Linked into the Linux and
 * macOS builds (scripts/build-native.mjs).
 *
 * The socket file is created with mode 0600, and the server serves a client
 * only after checking that it runs as the same user. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "listen-posix.h"

/* The socket file this process bound, which tsc_ts_unlink removes if the
 * path still names it. */
static dev_t bound_device;
static ino_t bound_inode;
static int bound = 0;

/* Fills `address` with the path in `bytes`; 0 when the path is empty, too
 * long for a socket address or contains a NUL. */
static int socket_address(struct sockaddr_un *address, const uint8_t *bytes, size_t size) {
  memset(address, 0, sizeof *address);
  address->sun_family = AF_UNIX;
  if (size == 0 || size >= sizeof address->sun_path || memchr(bytes, 0, size) != NULL) return 0;
  memcpy(address->sun_path, bytes, size);
  return 1;
}

static void close_on_exec(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags >= 0) fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

/* Whether a server listens on the socket at `address`. The probe does not
 * wait: a server whose queue of pending clients is full still listens. */
static int socket_answers(const struct sockaddr_un *address) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return 0;
  int flags = fcntl(fd, F_GETFL);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  int answers = connect(fd, (const struct sockaddr *)address, sizeof *address) == 0 || errno == EAGAIN ||
                errno == EWOULDBLOCK || errno == EINPROGRESS;
  close(fd);
  return answers;
}

int32_t tsc_ts_listen(const uint8_t *bytes, size_t size) {
  struct sockaddr_un address;
  if (!socket_address(&address, bytes, size)) {
    fprintf(stderr, "tsc-ts: invalid socket path\n");
    return -1;
  }
  /* A client that closes its end mid-reply makes the write fail with EPIPE
   * instead of ending the process. */
  signal(SIGPIPE, SIG_IGN);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    fprintf(stderr, "tsc-ts: cannot create socket %s: %s\n", address.sun_path, strerror(errno));
    return -1;
  }
  close_on_exec(fd);
  struct stat info;
  /* A socket file no server answers on is left by a server that ended
   * without removing it. */
  if (lstat(address.sun_path, &info) == 0 && S_ISSOCK(info.st_mode) && !socket_answers(&address))
    unlink(address.sun_path);
  mode_t mask = umask(0077);
  int status = bind(fd, (const struct sockaddr *)&address, sizeof address);
  int error = errno;
  umask(mask);
  if (status != 0) {
    fprintf(stderr, "tsc-ts: cannot listen on socket %s: %s\n", address.sun_path, strerror(error));
    close(fd);
    return -1;
  }
  if (stat(address.sun_path, &info) == 0) {
    bound_device = info.st_dev;
    bound_inode = info.st_ino;
    bound = 1;
  }
  if (listen(fd, 16) != 0) {
    fprintf(stderr, "tsc-ts: cannot listen on socket %s: %s\n", address.sun_path, strerror(errno));
    tsc_ts_unlink(bytes, size);
    close(fd);
    return -1;
  }
  return fd;
}

/* Whether the client connected on `fd` runs as this process's user. */
static int client_is_same_user(int fd) {
#if defined(__linux__)
  struct ucred credentials;
  socklen_t length = sizeof credentials;
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) return 0;
  return credentials.uid == geteuid();
#else
  uid_t uid;
  gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0) return 0;
  return uid == geteuid();
#endif
}

static int64_t now_ms(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

int32_t tsc_ts_accept(int32_t listener, int32_t timeout_ms) {
  int64_t deadline = timeout_ms < 0 ? -1 : now_ms() + timeout_ms;
  for (;;) {
    int wait = -1;
    if (deadline >= 0) {
      int64_t left = deadline - now_ms();
      wait = left <= 0 ? 0 : left > INT32_MAX ? INT32_MAX : (int)left;
    }
    struct pollfd entry = {listener, POLLIN, 0};
    int ready = poll(&entry, 1, wait);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) {
      fprintf(stderr, "tsc-ts: cannot wait for a client: %s\n", strerror(errno));
      return -1;
    }
    if (ready == 0) {
      if (deadline >= 0 && now_ms() >= deadline) return -2;
      continue;
    }
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) {
      /* The client gave up before it was accepted. */
      if (errno == EINTR || errno == ECONNABORTED || errno == EAGAIN || errno == EWOULDBLOCK) continue;
      fprintf(stderr, "tsc-ts: cannot accept a client: %s\n", strerror(errno));
      return -1;
    }
    close_on_exec(fd);
    if (!client_is_same_user(fd)) {
      fprintf(stderr, "tsc-ts: a client of the socket does not run as this user\n");
      close(fd);
      continue;
    }
    return fd;
  }
}

void tsc_ts_close(int32_t fd) {
  if (fd >= 0) close(fd);
}

void tsc_ts_unlink(const uint8_t *bytes, size_t size) {
  struct sockaddr_un address;
  struct stat info;
  if (bound && socket_address(&address, bytes, size) && stat(address.sun_path, &info) == 0 &&
      info.st_dev == bound_device && info.st_ino == bound_inode)
    unlink(address.sun_path);
  bound = 0;
}
