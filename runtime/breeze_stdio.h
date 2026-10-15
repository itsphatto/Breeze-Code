#include <stdio.h>

/* Injected with -include so output appears immediately, even when piped. */
static void __attribute__((constructor)) breeze_unbuffer_stdout(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
}
