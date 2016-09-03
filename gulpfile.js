var gulp  = require('gulp');
var jsdeps  = require('gulp-js-deps');
var gutil = require('gulp-util');
var clean = require('gulp-clean');
var shell = require('gulp-shell');

function buildDeps(glob) {
  gutil.log(gutil.colors.green('Building dependency list for'), glob);
  return gulp.src(glob, {read: false})
  .pipe(jsdeps.build())
  .pipe(gulp.dest('.deps'));
}

gulp.task('build-deps', ['clean-deps'], done => {
  return buildDeps(['spec/**/*Spec.js']);
});

gulp.task('clean-deps', done => {
  return gulp.src('.deps')
  .pipe(clean());
});

gulp.task('test', ['build-deps'], cb => {
  gulp.watch(['src/**/*.js', 'spec/**/*.js'], file => {
    // Look through dependency cache
    gulp.src('.deps/**/*.js')
    // Find the files affected by the modified `file`
    .pipe(jsdeps.dependsOn(file.path))
    .pipe(shell('node <%= file.path %> | node_modules/tap-diff/distributions/cli.js', {env: {FORCE_COLOR: true}, ignoreErrors: true}))
    .pipe(jsdeps.build())
    .pipe(gulp.dest('.deps'));
  });
});
