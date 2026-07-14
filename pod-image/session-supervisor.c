#define _GNU_SOURCE

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop_signal = 0;

static void request_stop(int signal_number) {
  stop_signal = signal_number;
}

static int read_parent_pid(pid_t pid, pid_t *parent) {
  char path[64];
  char buffer[4096];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(path, "r");
  if (!file) return -1;
  if (!fgets(buffer, sizeof(buffer), file)) {
    fclose(file);
    return -1;
  }
  fclose(file);
  char *command_end = strrchr(buffer, ')');
  if (!command_end || sscanf(command_end + 2, "%*c %d", parent) != 1) return -1;
  return 0;
}

static int is_descendant(pid_t candidate, pid_t root) {
  pid_t current = candidate;
  for (int depth = 0; depth < 256; depth += 1) {
    pid_t parent = 0;
    if (read_parent_pid(current, &parent) != 0 || parent <= 1 || parent == current) return 0;
    if (parent == root) return 1;
    current = parent;
  }
  return 0;
}

static int visit_descendants(pid_t root, int signal_number) {
  DIR *proc = opendir("/proc");
  if (!proc) return 0;
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(proc)) != NULL) {
    if (!isdigit((unsigned char)entry->d_name[0])) continue;
    char *end = NULL;
    long value = strtol(entry->d_name, &end, 10);
    if (!end || *end != '\0' || value <= 1 || value == root) continue;
    pid_t pid = (pid_t)value;
    if (!is_descendant(pid, root)) continue;
    count += 1;
    if (signal_number != 0 && kill(pid, signal_number) != 0 && errno != ESRCH) {
      fprintf(stderr, "reaper-session: cannot signal pid %ld: %s\n", value, strerror(errno));
    }
  }
  closedir(proc);
  return count;
}

static void reap_exited_children(void) {
  int status = 0;
  while (waitpid(-1, &status, WNOHANG) > 0) {}
}

static void stop_all_descendants(pid_t root) {
  visit_descendants(root, SIGTERM);
  struct timespec pause = { .tv_sec = 0, .tv_nsec = 50 * 1000 * 1000 };
  for (int attempt = 0; attempt < 20; attempt += 1) {
    reap_exited_children();
    if (visit_descendants(root, 0) == 0) return;
    nanosleep(&pause, NULL);
  }
  visit_descendants(root, SIGKILL);
  for (int attempt = 0; attempt < 20; attempt += 1) {
    reap_exited_children();
    if (visit_descendants(root, 0) == 0) return;
    nanosleep(&pause, NULL);
  }
}

static int install_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  for (size_t index = 0; index < 4; index += 1) {
    const int signals[] = { SIGHUP, SIGINT, SIGTERM, SIGQUIT };
    if (sigaction(signals[index], &action, NULL) != 0) return -1;
  }
  return 0;
}

int main(int argc, char **argv) {
  const char *rcfile = argc > 1 ? argv[1] : "";
  const char *session = argc > 2 ? argv[2] : "";
  if (session[0] == '\0' || setenv("REAPER_SESSION_ID", session, 1) != 0) {
    fprintf(stderr, "reaper-session: cannot set session identity: %s\n", session[0] == '\0' ? "missing name" : strerror(errno));
    return 1;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) {
    fprintf(stderr, "reaper-session: cannot become a child subreaper: %s\n", strerror(errno));
    return 1;
  }
  if (install_signal_handlers() != 0) {
    fprintf(stderr, "reaper-session: cannot install signal handlers: %s\n", strerror(errno));
    return 1;
  }

  while (!stop_signal) {
    pid_t shell = fork();
    if (shell < 0) {
      fprintf(stderr, "reaper-session: cannot start shell: %s\n", strerror(errno));
      return 1;
    }
    if (shell == 0) {
      if (rcfile[0] != '\0') execl("/bin/bash", "bash", "--rcfile", rcfile, "-i", (char *)NULL);
      else execl("/bin/bash", "bash", "-i", (char *)NULL);
      fprintf(stderr, "reaper-session: cannot exec bash: %s\n", strerror(errno));
      _exit(127);
    }

    int shell_status = 0;
    for (;;) {
      pid_t reaped = waitpid(-1, &shell_status, 0);
      if (reaped == shell) break;
      if (reaped < 0) {
        if (errno == EINTR) {
          if (stop_signal) break;
          continue;
        }
        if (errno == ECHILD) break;
        fprintf(stderr, "reaper-session: wait failed: %s\n", strerror(errno));
        stop_signal = SIGTERM;
        break;
      }
    }

    if (stop_signal) break;
    int status = WIFEXITED(shell_status) ? WEXITSTATUS(shell_status) : 128 + WTERMSIG(shell_status);
    fprintf(stderr, "\033[38;5;214mReaper: shell exited with status %d; restarting this persistent session.\033[0m\n", status);
    struct timespec delay = { .tv_sec = 1, .tv_nsec = 0 };
    while (!stop_signal && nanosleep(&delay, &delay) != 0 && errno == EINTR) {}
  }

  const int signal_number = stop_signal || SIGTERM;
  stop_all_descendants(getpid());
  reap_exited_children();
  return 128 + signal_number;
}
