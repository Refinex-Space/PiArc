# PiArc shell integration for bash (bash 3.2 and newer, Git Bash included). PiArc starts
# bash with --rcfile pointing here: the user's startup files are read first as bash would
# read them, then the prompt marks are added. Reports prompts, typed commands, command output
# and exit codes (OSC 133 A, B, C, D) and the working directory (OSC 7). No file of the user's
# is changed.
if [ -n "${PIARC_SHELL_LOGIN-}" ]; then
  unset PIARC_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  for _piarc_file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$_piarc_file" ]; then
      . "$_piarc_file"
      break
    fi
  done
  unset _piarc_file
elif [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

if [ -z "${_PIARC_MARKS-}" ]; then
  _PIARC_MARKS=1
  _piarc_busy=0
  _piarc_at_prompt=0

  # Percent-encodes $1 into _piarc_url, byte by byte.
  _piarc_encode() {
    local LC_ALL=C text="$1" out="" char code i
    for (( i = 0; i < ${#text}; i++ )); do
      char="${text:i:1}"
      case "$char" in
        [A-Za-z0-9._~/-]) out="$out$char" ;;
        *)
          # bash 3.2 sign-extends bytes above 0x7f.
          printf -v code '%d' "'$char"
          printf -v char '%%%02X' "$(( code & 255 ))"
          out="$out$char"
          ;;
      esac
    done
    _piarc_url="$out"
  }

  _piarc_prompt() {
    local status_code=$?
    if [ "$_piarc_busy" = 1 ]; then
      printf '\033]133;D;%s\007' "$status_code"
      _piarc_busy=0
    fi
    local dir="$PWD"
    case "${OSTYPE-}" in
      msys* | cygwin*) dir="/$(pwd -W)" ;;
    esac
    _piarc_encode "$dir"
    printf '\033]7;file://%s%s\007\033]133;A\007' "${HOSTNAME-}" "$_piarc_url"
    case "$PS1" in
      *$'\033]133;B'*) ;;
      *) PS1="$PS1"$'\\[\033]133;B\007\\]' ;;
    esac
    _piarc_at_prompt=1
    return "$status_code"
  }

  # The DEBUG trap runs before every simple command, prompt commands included; only the first
  # one after a prompt starts what the user typed.
  _piarc_debug() {
    if [ "$_piarc_at_prompt" = 1 ]; then
      case "$BASH_COMMAND" in
        _piarc_prompt* ) return ;;
      esac
      _piarc_at_prompt=0
      _piarc_busy=1
      local line
      line="$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)"
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line#*[0-9] }"
      line="${line#"${line%%[![:space:]]*}"}"
      if [ -n "$line" ]; then
        _piarc_encode "$line"
        printf '\033]133;C;cmdline_url=%s\007' "$_piarc_url"
      else
        printf '\033]133;C\007'
      fi
    fi
  }

  PROMPT_COMMAND="_piarc_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  trap '_piarc_debug' DEBUG
fi
