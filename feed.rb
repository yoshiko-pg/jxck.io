#!/usr/bin/env ruby

entries = `find ./blog.jxck.io/entries -name *.md | sort -r`.split("\n").map{|name|
  href = name.gsub("./blog.jxck.io/", "https://blog.jxck.io/").gsub(".md", ".html")
  file = File.open(name)
  text = file.read
  title = text.match(/^# \[.*\] (.*)/)[1]
  summary = text.match(/## intro(.*?)##/im)[1].strip
  splitted = name.split("/")
  date = splitted[3]
  updated = "#{date}T00:00:00Z"

  <<-EOS
  <entry>
   <title>#{title}</title>
   <link href="#{href}"/>
   <id>tag:blog.jxck.io,2016:entry://#{date}</id>
   <updated>#{updated}</updated>
   <summary>#{summary}</summary>
  </entry>
EOS

}

feed = <<-EOS
<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns='http://www.w3.org/2005/Atom' xml:lang='ja'>
 <title>blog.jxck.io</title>
 <link href="https://blog.jxck.io/"/>
 <link rel="self" type="application/atom+xml" href="https://blog.jxck.io/feeds"/>
 <updated>2016-01-28T18:30:02Z</updated>
 <author>
   <name>Jxck</name>
 </author>
 <id>tag:blog.jxck.io,2016:feed</id>
#{entries.join("\n")}
</feed>
EOS
File.write("blog.jxck.io/feeds/atom.xml", feed)
